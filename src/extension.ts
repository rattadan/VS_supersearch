import * as vscode from 'vscode';
import { SuperSearchViewProvider } from './viewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SuperSearchViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('supersearch.view', provider),
    vscode.commands.registerCommand('supersearch.open', () =>
      vscode.commands.executeCommand('supersearch.view.focus')
    )
  );
}

export function deactivate(): void {}
