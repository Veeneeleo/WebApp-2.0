// ble_uart.js
// Nordic UART UUIDs (common BLE "UART" service)
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_RX_UUID      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write
const UART_TX_UUID      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify

function enc(str){ return new TextEncoder().encode(str); }

export class BleUartClient {
  constructor({ onText } = {}) {
    this.device = null;
    this.server = null;
    this.rx = null;
    this.tx = null;
    this.onText = onText || (() => {});
    this._connected = false;
  }

  get connected() { return this._connected; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UART_SERVICE_UUID] }],
    });

    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(UART_SERVICE_UUID);

    this.rx = await svc.getCharacteristic(UART_RX_UUID);
    this.tx = await svc.getCharacteristic(UART_TX_UUID);

    await this.tx.startNotifications();
    this.tx.addEventListener("characteristicvaluechanged", (ev) => {
      const v = ev.target.value;
      const bytes = new Uint8Array(v.buffer);
      const text = new TextDecoder().decode(bytes);
      this.onText(text);
    });

    this._connected = true;
    return true;
  }

  async disconnect() {
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch {}
    this._connected = false;
  }

  async writeLine(line) {
    if (!this._connected) throw new Error("BLE not connected");
    if (!line.endsWith("\n")) line += "\n";
    const data = enc(line);
    if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(data);
    else await this.rx.writeValue(data);
  }

  async writeBytes(u8) {
    if (!this._connected) throw new Error("BLE not connected");
    if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(u8);
    else await this.rx.writeValue(u8);
  }

  // Upload protocol expected by your dvs_core UNIX server:
  // UPLOAD_BEGIN <name> <size>\n
  // <raw bytes exactly size>
  async uploadFile(file, { chunkSize = 180, onProgress } = {}) {
    onProgress = onProgress || (() => {});
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const safeName = file.name.replace(/\s+/g, "_");

    await this.writeLine(`UPLOAD_BEGIN ${safeName} ${bytes.byteLength}`);

    let sent = 0;
    while (sent < bytes.byteLength) {
      const end = Math.min(sent + chunkSize, bytes.byteLength);
      const chunk = bytes.slice(sent, end);
      await this.writeBytes(chunk);
      sent = end;
      onProgress(sent / bytes.byteLength);

      // yield to avoid iOS BLE choking
      await new Promise(r => setTimeout(r, 0));
    }
  }
}
