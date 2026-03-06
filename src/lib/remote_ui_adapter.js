export class RemoteUiAdapter {
  name() {
    return "remote-ui";
  }

  status() {
    return {
      enabled: false,
      running: false,
    };
  }

  async start() {
    throw new Error("RemoteUiAdapter.start() not implemented");
  }

  async stop() {
    throw new Error("RemoteUiAdapter.stop() not implemented");
  }

  async sendText(_chatId, _text) {
    throw new Error("RemoteUiAdapter.sendText() not implemented");
  }

  async sendMarkdown(_chatId, _payload) {
    throw new Error("RemoteUiAdapter.sendMarkdown() not implemented");
  }

  async patchMessage(_messageId, _payload) {
    throw new Error("RemoteUiAdapter.patchMessage() not implemented");
  }

  async sendImage(_chatId, _imagePath) {
    throw new Error("RemoteUiAdapter.sendImage() not implemented");
  }

  async sendBindHint(_chatId, _payload) {
    throw new Error("RemoteUiAdapter.sendBindHint() not implemented");
  }
}

export function toRemoteUiStatus(adapter) {
  if (!adapter || typeof adapter.status !== "function") {
    return {
      enabled: false,
      running: false,
    };
  }
  return adapter.status();
}
