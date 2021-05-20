/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types='@gitpod/gitpod-protocol/lib/typings/globals'/>

import type { IDEFrontendState } from '@gitpod/gitpod-protocol/lib/ide-frontend-service';
import { isStandalone } from 'vs/base/browser/browser';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { isEqual } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { parseLogLevel } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { defaultWebSocketFactory } from 'vs/platform/remote/browser/browserSocketFactory';
import { extractLocalHostUriMetaDataForPortMapping, isLocalhost } from 'vs/platform/remote/common/tunnel';
import { ColorScheme } from 'vs/platform/theme/common/theme';
import { isFolderToOpen, isWorkspaceToOpen } from 'vs/platform/windows/common/windows';
import { commands, create, ICommand, ICredentialsProvider, IHomeIndicator, ITunnel, ITunnelProvider, IWorkspace, IWorkspaceProvider } from 'vs/workbench/workbench.web.api';
import { grpc } from '@improbable-eng/grpc-web';
import { LocalAppClient, TunnelStatusRequest, TunnelStatus, TunnelVisiblity, Status } from '@gitpod/local-app-api-grpcweb';

interface ICredential {
	service: string;
	account: string;
	password: string;
}

class LocalStorageCredentialsProvider implements ICredentialsProvider {

	static readonly CREDENTIALS_OPENED_KEY = 'credentials.provider';

	private _credentials: ICredential[] | undefined;
	private get credentials(): ICredential[] {
		if (!this._credentials) {
			try {
				const serializedCredentials = window.localStorage.getItem(LocalStorageCredentialsProvider.CREDENTIALS_OPENED_KEY);
				if (serializedCredentials) {
					this._credentials = JSON.parse(serializedCredentials);
				}
			} catch (error) {
				// ignore
			}

			if (!Array.isArray(this._credentials)) {
				this._credentials = [];
			}
		}

		return this._credentials;
	}

	private save(): void {
		window.localStorage.setItem(LocalStorageCredentialsProvider.CREDENTIALS_OPENED_KEY, JSON.stringify(this.credentials));
	}

	async getPassword(service: string, account: string): Promise<string | null> {
		for (const credential of this.credentials) {
			if (credential.service === service) {
				if (typeof account !== 'string' || account === credential.account) {
					return credential.password;
				}
			}
		}

		return null;
	}

	async setPassword(service: string, account: string, password: string): Promise<void> {
		this.deletePassword(service, account);

		this.credentials.push({ service, account, password });

		this.save();
	}

	async deletePassword(service: string, account: string): Promise<boolean> {
		let found = false;

		this._credentials = this.credentials.filter(credential => {
			if (credential.service === service && credential.account === account) {
				found = true;

				return false;
			}

			return true;
		});

		if (found) {
			this.save();
		}

		return found;
	}

	async findPassword(_service: string): Promise<string | null> {
		return null;
	}

	async findCredentials(_service: string): Promise<Array<{ account: string, password: string }>> {
		return [];
	}

}

class WorkspaceProvider implements IWorkspaceProvider {

	static QUERY_PARAM_EMPTY_WINDOW = 'ew';
	static QUERY_PARAM_FOLDER = 'folder';
	static QUERY_PARAM_WORKSPACE = 'workspace';

	static QUERY_PARAM_PAYLOAD = 'payload';

	readonly trusted = true;

	constructor(
		public readonly workspace: IWorkspace,
		public readonly payload: object
	) { }

	async open(workspace: IWorkspace, options?: { reuse?: boolean, payload?: object }): Promise<boolean> {
		if (options?.reuse && !options.payload && this.isSame(this.workspace, workspace)) {
			return true; // return early if workspace and environment is not changing and we are reusing window
		}

		const targetHref = this.createTargetUrl(workspace, options);
		if (targetHref) {
			if (options?.reuse) {
				window.location.href = targetHref;
				return true;
			} else {
				let result;
				if (isStandalone) {
					result = window.open(targetHref, '_blank', 'toolbar=no'); // ensures to open another 'standalone' window!
				} else {
					result = window.open(targetHref);
				}

				return !!result;
			}
		}
		return false;
	}

	private createTargetUrl(workspace: IWorkspace, options?: { reuse?: boolean, payload?: object }): string | undefined {

		// Empty
		let targetHref: string | undefined = undefined;
		if (!workspace) {
			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW}=true`;
		}

		// Folder
		else if (isFolderToOpen(workspace)) {
			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_FOLDER}=${encodeURIComponent(workspace.folderUri.toString())}`;
		}

		// Workspace
		else if (isWorkspaceToOpen(workspace)) {
			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_WORKSPACE}=${encodeURIComponent(workspace.workspaceUri.toString())}`;
		}

		// Append payload if any
		if (options?.payload) {
			targetHref += `&${WorkspaceProvider.QUERY_PARAM_PAYLOAD}=${encodeURIComponent(JSON.stringify(options.payload))}`;
		}

		return targetHref;
	}

	private isSame(workspaceA: IWorkspace, workspaceB: IWorkspace): boolean {
		if (!workspaceA || !workspaceB) {
			return workspaceA === workspaceB; // both empty
		}

		if (isFolderToOpen(workspaceA) && isFolderToOpen(workspaceB)) {
			return isEqual(workspaceA.folderUri, workspaceB.folderUri); // same workspace
		}

		if (isWorkspaceToOpen(workspaceA) && isWorkspaceToOpen(workspaceB)) {
			return isEqual(workspaceA.workspaceUri, workspaceB.workspaceUri); // same workspace
		}

		return false;
	}

	hasRemote(): boolean {
		if (this.workspace) {
			if (isFolderToOpen(this.workspace)) {
				return this.workspace.folderUri.scheme === Schemas.vscodeRemote;
			}

			if (isWorkspaceToOpen(this.workspace)) {
				return this.workspace.workspaceUri.scheme === Schemas.vscodeRemote;
			}
		}

		return true;
	}
}

const devMode = product.nameShort.endsWith(' Dev');

let _state: IDEFrontendState = 'init';
let _failureCause: Error | undefined;
const onDidChangeEmitter = new Emitter<void>();
const toStop = new DisposableStore();
toStop.add(onDidChangeEmitter);
toStop.add({
	dispose: () => {
		_state = 'terminated';
		onDidChangeEmitter.fire();
	}
});

function start(): IDisposable {
	doStart().then(toDoStop => {
		toStop.add(toDoStop);
		_state = 'ready';
		onDidChangeEmitter.fire();
	}, e => {
		_failureCause = e;
		_state = 'terminated';
		onDidChangeEmitter.fire();
	});
	return toStop;
}

async function doStart(): Promise<IDisposable> {
	let supervisorHost = window.location.host;
	// running from sources
	if (devMode) {
		supervisorHost = supervisorHost.substring(supervisorHost.indexOf('-') + 1);
	}
	const infoResponse = await fetch(window.location.protocol + '//' + supervisorHost + '/_supervisor/v1/info/workspace', {
		credentials: 'include'
	});
	if (!infoResponse.ok) {
		throw new Error(`Getting workspace info failed: ${infoResponse.statusText}`);
	}
	if (_state === 'terminated') {
		return Disposable.None;
	}

	const subscriptions = new DisposableStore();

	const info: {
		workspaceId: string
		instanceId: string
		checkoutLocation: string
		workspaceLocationFile?: string
		workspaceLocationFolder?: string
		userHome: string
		gitpodHost: string
		gitpodApi: {
			host: string
		}
		workspaceContextUrl: string
	} = await infoResponse.json();
	if (_state as any === 'terminated') {
		return Disposable.None;
	}

	const remotePort = location.protocol === 'https:' ? '443' : '80';
	const remoteAuthority = window.location.host + ':' + remotePort;

	const webWorkerExtensionHostEndpoint = new URL(document.baseURI);
	webWorkerExtensionHostEndpoint.host = 'extensions-' + webWorkerExtensionHostEndpoint.host;
	webWorkerExtensionHostEndpoint.pathname += (location.protocol === 'https:'
		? 'out/vs/workbench/services/extensions/worker/httpsWebWorkerExtensionHostIframe.html'
		: 'out/vs/workbench/services/extensions/worker/httpsWebWorkerExtensionHostIframe.html');
	webWorkerExtensionHostEndpoint.search = '';
	webWorkerExtensionHostEndpoint.hash = '';

	const webviewEndpoint = new URL(document.baseURI);
	webviewEndpoint.host = 'webview-' + webviewEndpoint.host;
	webviewEndpoint.pathname += 'out/vs/workbench/contrib/webview/browser/pre';
	webviewEndpoint.search = '';
	webviewEndpoint.hash = '';

	// Find workspace to open and payload
	let foundWorkspace = false;
	let workspace: IWorkspace;
	let payload = Object.create(null);
	let logLevel: string | undefined = undefined;

	const query = new URL(document.location.href).searchParams;
	query.forEach((value, key) => {
		switch (key) {

			// Folder
			case WorkspaceProvider.QUERY_PARAM_FOLDER:
				workspace = { folderUri: URI.parse(value) };
				foundWorkspace = true;
				break;

			// Workspace
			case WorkspaceProvider.QUERY_PARAM_WORKSPACE:
				workspace = { workspaceUri: URI.parse(value) };
				foundWorkspace = true;
				break;

			// Empty
			case WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW:
				workspace = undefined;
				foundWorkspace = true;
				break;

			// Payload
			case WorkspaceProvider.QUERY_PARAM_PAYLOAD:
				try {
					payload = JSON.parse(value);
				} catch (error) {
					console.error(error); // possible invalid JSON
				}
				break;

			// Log level
			case 'logLevel':
				logLevel = value;
				break;
		}
	});

	if (!foundWorkspace) {
		if (info.workspaceLocationFile) {
			workspace = {
				workspaceUri: URI.from({
					scheme: 'vscode-remote',
					authority: remoteAuthority,
					path: info.workspaceLocationFile
				})
			};
		} else if (info.workspaceLocationFolder) {
			workspace = {
				folderUri: URI.from({
					scheme: 'vscode-remote',
					authority: remoteAuthority,
					path: info.workspaceLocationFolder
				})
			};
		}
	}

	// Workspace Provider
	const workspaceProvider = new WorkspaceProvider(workspace, payload);

	const homeIndicator: IHomeIndicator = {
		href: info.gitpodHost,
		icon: 'code',
		title: localize('home', "Home")
	};

	const gitpodHostURL = new URL(info.gitpodHost);
	const gitpodDomain = gitpodHostURL.protocol + '//*.' + gitpodHostURL.host;
	const syncStoreURL = info.gitpodHost + '/code-sync';

	const credentialsProvider = new LocalStorageCredentialsProvider();
	interface GetTokenResponse {
		token: string
		user?: string
		scope?: string[]
	}
	const scopes = [
		'function:accessCodeSyncStorage'
	];
	const tokenResponse = await fetch(window.location.protocol + '//' + supervisorHost + '/_supervisor/v1/token/gitpod/' + info.gitpodApi.host + '/' + scopes.join(','), {
		credentials: 'include'
	});
	if (_state as any === 'terminated') {
		return Disposable.None;
	}
	if (!tokenResponse.ok) {
		console.warn(`Getting Gitpod token failed: ${tokenResponse.statusText}`);
	} else {
		const getToken: GetTokenResponse = await tokenResponse.json();
		if (_state as any === 'terminated') {
			return Disposable.None;
		}

		// see https://github.com/gitpod-io/vscode/blob/gp-code/src/vs/workbench/services/authentication/browser/authenticationService.ts#L34
		type AuthenticationSessionInfo = { readonly id: string, readonly accessToken: string, readonly providerId: string, readonly canSignOut?: boolean };
		const currentSession: AuthenticationSessionInfo = {
			// current session ID should remain stable between window reloads
			// otherwise setting sync will log out
			id: 'gitpod-current-session',
			accessToken: getToken.token,
			providerId: 'gitpod',
			canSignOut: false
		};
		// Settings Sync Entry
		await credentialsProvider.setPassword(`${product.urlProtocol}.login`, 'account', JSON.stringify(currentSession));
		// Auth extension Entry
		await credentialsProvider.setPassword(`${product.urlProtocol}-gitpod.login`, 'account', JSON.stringify([{
			id: currentSession.id,
			scopes: getToken.scope || scopes,
			accessToken: currentSession.accessToken
		}]));
	}
	if (_state as any === 'terminated') {
		return Disposable.None;
	}

	//#region tunnels
	class Tunnel implements ITunnel {
		localAddress: string;
		remoteAddress: { port: number; host: string; };
		public?: boolean;

		private readonly onDidDisposeEmitter = new Emitter<void>();
		readonly onDidDispose = this.onDidDisposeEmitter.event;
		private disposed = false;
		constructor(
			public status: TunnelStatus.AsObject
		) {
			this.remoteAddress = {
				host: 'localhost',
				port: status.remotePort
			};
			this.localAddress = 'localhost:' + status.localPort;
			this.public = status.visibility === TunnelVisiblity.NETWORK;
		}
		async dispose(close = true): Promise<void> {
			if (this.disposed) {
				return;
			}
			this.disposed = true;
			if (close) {
				try {
					await commands.executeCommand('gitpod.api.closeTunnel', this.remoteAddress.port);
				} catch (e) {
					console.error('failed to close tunnel', e);
				}
			}
			this.onDidDisposeEmitter.fire(undefined);
			this.onDidDisposeEmitter.dispose();
		}
	}
	const tunnels = new Map<number, Tunnel>();
	const onDidChangeTunnels = new Emitter<void>();
	function observeTunneled(apiPort: number): IDisposable {
		const client = new LocalAppClient('http://localhost:' + apiPort, {
			transport: grpc.WebsocketTransport()
		});
		commands.executeCommand('setContext', 'gitpod.localAppConnected', true);
		let run = true;
		let stopUpdates: Function | undefined;
		let attempts = 0;
		let reconnectDelay = 1000;
		const maxAttempts = 5;
		(async () => {
			while (run) {
				if (attempts === maxAttempts) {
					commands.executeCommand('setContext', 'gitpod.localAppConnected', false);
					console.error(`could not connect to local app ${maxAttempts} times, giving up, use 'Gitpod: Connect to Local App' command to retry`);
					return;
				}
				let err: Error | undefined;
				let status: Status | undefined;
				try {
					const request = new TunnelStatusRequest();
					request.setObserve(true);
					request.setInstanceId(info.instanceId);
					const stream = client.tunnelStatus(request);
					stopUpdates = stream.cancel.bind(stream);
					status = await new Promise<Status | undefined>(resolve => {
						stream.on('end', resolve);
						stream.on('data', response => {
							attempts = 0;
							reconnectDelay = 1000;
							let notify = false;
							const toDispose = new Set(tunnels.keys());
							for (const status of response.getTunnelsList()) {
								toDispose.delete(status.getRemotePort());
								const tunnel = new Tunnel(status.toObject());
								let existing = tunnels.get(status.getRemotePort());
								if (!existing || existing.public !== tunnel.public) {
									existing?.dispose(false);
									tunnels.set(status.getRemotePort(), tunnel);
									commands.executeCommand('gitpod.vscode.workspace.openTunnel', {
										remoteAddress: tunnel.remoteAddress,
										localAddressPort: tunnel.remoteAddress.port,
										public: tunnel.public
									});
									notify = true;
								}
							}
							for (const port of toDispose) {
								const tunnel = tunnels.get(port);
								if (tunnel) {
									tunnel.dispose(false);
									tunnels.delete(port);
									notify = true;
								}
							}
							if (notify) {
								onDidChangeTunnels.fire(undefined);
							}
						});
					});
				} catch (e) {
					err = e;
				} finally {
					stopUpdates = undefined;
				}
				if (tunnels.size) {
					for (const tunnel of tunnels.values()) {
						tunnel.dispose(false);
					}
					tunnels.clear();
					onDidChangeTunnels.fire(undefined);
				}
				if (status?.code !== grpc.Code.Canceled) {
					console.warn('cannot maintain connection to local app', err || status);
				}
				await new Promise(resolve => setTimeout(resolve, reconnectDelay));
				reconnectDelay = reconnectDelay * 1.5;
				attempts++;
			}
		})();
		return {
			dispose: () => {
				run = false;
				if (stopUpdates) {
					stopUpdates();
				}
			}
		};
	}
	const defaultApiPort = 63100;
	let cancelObserveTunneled = observeTunneled(defaultApiPort);
	subscriptions.add(cancelObserveTunneled);
	const connectLocalApp: ICommand = {
		id: 'gitpod.api.connectLocalApp',
		handler: (apiPort: number = defaultApiPort) => {
			cancelObserveTunneled.dispose();
			cancelObserveTunneled = observeTunneled(apiPort);
			subscriptions.add(cancelObserveTunneled);
		}
	};
	const getTunnels: ICommand = {
		id: 'gitpod.getTunnels',
		handler: () => /* vscode.TunnelDescription[] */ {
			const result: {
				remoteAddress: { port: number, host: string; };
				//The complete local address(ex. localhost:1234)
				localAddress: { port: number, host: string; } | string;
				public?: boolean;
			}[] = [];
			for (const tunnel of tunnels.values()) {
				result.push({
					remoteAddress: tunnel.remoteAddress,
					localAddress: tunnel.localAddress,
					public: tunnel.public
				});
			}
			return result;
		}
	};
	const tunnelProvider: ITunnelProvider = {
		features: {
			public: true,
			elevation: false
		},
		tunnelFactory: async (tunnelOptions, tunnelCreationOptions) => {
			const remotePort = tunnelOptions.remoteAddress.port;
			try {
				if (!isLocalhost(tunnelOptions.remoteAddress.host)) {
					throw new Error('only tunneling of localhost is supported, but: ' + tunnelOptions.remoteAddress.host);
				}
				let tunnel = tunnels.get(remotePort);
				if (!tunnel) {
					await commands.executeCommand('gitpod.api.openTunnel', tunnelOptions, tunnelCreationOptions);
					tunnel = tunnels.get(remotePort) || await new Promise<Tunnel>(resolve => {
						const toUnsubscribe = onDidChangeTunnels.event(() => {
							const resolved = tunnels.get(remotePort);
							if (resolved) {
								resolve(resolved);
								toUnsubscribe.dispose();
							}
						});
						subscriptions.add(toUnsubscribe);
					});
				}
				return tunnel;
			} catch (e) {
				console.trace(`failed to tunnel to '${tunnelOptions.remoteAddress.host}':'${remotePort}': `, e);
				// actually should be external URL and this method should never throw
				const tunnel = new Tunnel({
					localPort: remotePort,
					remotePort: remotePort,
					visibility: TunnelVisiblity.NONE
				});
				// closed tunnel, invalidate in next tick
				setTimeout(() => tunnel.dispose(false));
				return tunnel;
			}
		}
	};
	//#endregion

	subscriptions.add(create(document.body, {
		remoteAuthority,
		webviewEndpoint: webviewEndpoint.toString(),
		webSocketFactory: {
			create: url => {
				const codeServerUrl = new URL(url);
				codeServerUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
				codeServerUrl.port = remotePort;
				return defaultWebSocketFactory.create(codeServerUrl.toString());
			}
		},
		workspaceProvider,
		resolveExternalUri: async (uri) => {
			const localhost = extractLocalHostUriMetaDataForPortMapping(uri);
			if (!localhost) {
				return uri;
			}
			const tunnel = tunnels.get(localhost.port);
			if (tunnel) {
				return URI.parse('http://localhost:' + tunnel.status.localPort);
			}
			const publicUrl = (await commands.executeCommand('gitpod.resolveExternalPort', localhost.port)) as any as string;
			return URI.parse(publicUrl);
		},
		homeIndicator,
		windowIndicator: {
			onDidChange: Event.None,
			label: `$(gitpod) Gitpod`,
			tooltip: 'Editing on Gitpod'
		},
		initialColorTheme: {
			themeType: ColorScheme.LIGHT,
			// should be aligned with extensions/theme-defaults/themes/gitpod-light-color-theme.json
			colors: {
				'statusBarItem.remoteBackground': '#FF8A00',
				'statusBarItem.remoteForeground': '#f9f9f9',
				'statusBar.background': '#F3F3F3',
				'statusBar.foreground': '#292524',
				'statusBar.noFolderBackground': '#FF8A00',
				'statusBar.debuggingBackground': '#FF8A00',
				'sideBar.background': '#fcfcfc',
				'sideBarSectionHeader.background': '#f9f9f9',
				'activityBar.background': '#f9f9f9',
				'activityBar.foreground': '#292524',
				'editor.background': '#ffffff',
				'button.background': '#FF8A00',
				'button.foreground': '#ffffff',
				'list.activeSelectionBackground': '#e7e5e4',
				'list.activeSelectionForeground': '#292524',
				'list.inactiveSelectionForeground': '#292524',
				'list.inactiveSelectionBackground': '#F9F9F9',
				'minimap.background': '#FCFCFC',
				'minimapSlider.activeBackground': '#F9F9F9',
				'tab.inactiveBackground': '#F9F9F9',
				'editor.selectionBackground': '#FFE4BC',
				'editor.inactiveSelectionBackground': '#FFE4BC'
			}
		},
		configurationDefaults: {
			'workbench.colorTheme': 'Gitpod Light',
		},
		developmentOptions: {
			logLevel: logLevel ? parseLogLevel(logLevel) : undefined
		},
		credentialsProvider,
		productConfiguration: {
			linkProtectionTrustedDomains: [
				...(product.linkProtectionTrustedDomains || []),
				gitpodDomain
			],
			'configurationSync.store': {
				url: syncStoreURL,
				stableUrl: syncStoreURL,
				insidersUrl: syncStoreURL,
				canSwitch: false,
				authenticationProviders: {
					gitpod: {
						scopes: ['function:accessCodeSyncStorage']
					}
				}
			}
		},
		defaultLayout: {
			views: [{
				id: 'terminal'
			}]
		},
		settingsSyncOptions: {
			enabled: true,
			enablementHandler: enablement => {
				// TODO
			}
		},
		webWorkerExtensionHostIframeSrc: webWorkerExtensionHostEndpoint.toString(),
		tunnelProvider,
		commands: [
			getTunnels,
			connectLocalApp
		]
	}));
	return subscriptions;
}

if (devMode) {
	doStart();
} else {
	window.gitpod.ideService = {
		get state() {
			return _state;
		},
		get failureCause() {
			return _failureCause;
		},
		onDidChange: onDidChangeEmitter.event,
		start: () => start()
	};
}
