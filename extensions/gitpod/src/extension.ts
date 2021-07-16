import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodCodeServer, registerAuth, registerCLI, registerDefaultLayout, registerExtensionManagement, registerHearbeat, registerNotifications, registerPorts, registerTunneling, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';

export async function activate(context: vscode.ExtensionContext) {
	if (typeof vscode.env.remoteName === 'undefined' || context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
		return;
	}

	const gitpodContext = await createGitpodExtensionContext(context);
	registerWorkspaceCommands(gitpodContext);
	registerWorkspaceSharing(gitpodContext);
	registerWorkspaceTimeout(gitpodContext);
	registerPorts(gitpodContext);
	registerNotifications(gitpodContext);
	registerDefaultLayout(gitpodContext);
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		registerAuth(gitpodContext);
		registerTunneling(gitpodContext);

		const codeServer = new GitpodCodeServer();
		registerCLI(codeServer, gitpodContext);
		registerExtensionManagement(codeServer, gitpodContext);
	} else {
		registerHearbeat(gitpodContext);
		// TODO
		// - auth?
		// - extension management
		// - port tunneling - disable auto port forwarding for such workspace and rely on Remote SSH
		// - cli integration
		//   - credential helper
		//   - gp
		// - tasks
	}

	await Promise.all(gitpodContext.pendingActivate.map(p => p.catch(console.error)));
}

export function deactivate() { }
