function isWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isTrustedSender(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

module.exports = { isTrustedSender, isWebUrl };
