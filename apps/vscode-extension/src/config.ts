import * as vscode from 'vscode';

export interface GraphnosisConfig {
  httpBridgeUrl: string;
  bearerToken: string;
  autoInject: boolean;
  autoInjectMaxTier: 'public' | 'personal';
  maxTokensPerInjection: number;
}

export function getConfig(): GraphnosisConfig {
  const cfg = vscode.workspace.getConfiguration('graphnosis');
  return {
    httpBridgeUrl: cfg.get('httpBridgeUrl', 'http://127.0.0.1:3457/mcp'),
    bearerToken: cfg.get('bearerToken', ''),
    autoInject: cfg.get('autoInject', true),
    autoInjectMaxTier: cfg.get<'public' | 'personal'>('autoInjectMaxTier', 'personal'),
    maxTokensPerInjection: cfg.get('maxTokensPerInjection', 1500),
  };
}
