import {RunProgram, CheckOutput} from './server-types';

/**
 * Worker class for server REST sequence
 *
 * @export
 * @class ServerWorker
 */
export class ServerWorker {
  private readonly server: string;
  private readonly cb: (data: CheckOutput.FS) => boolean;
  private readonly INTERNAL_ERROR_MESSAGE =
  'Please report this issue on https://github.com/AdaCore/learn/issues';

  /**
   * The data processing callback for server data
   *
   * @callback dataCallback
   * @param {CheckOutput.FS} data - The data to process
   * @return {number} - The number of lines processed
   */

  /**
   * Creates an instance of ServerWorker.
   * @param {string} server - The server address
   * @param {dataCallback} dataCB - The process data callback
   */
  constructor(server: string, dataCB: (data: CheckOutput.FS) => boolean) {
    this.server = server;
    this.cb = dataCB;
  }

  /**
   * Entrypoint for initiating requests to the server
   *
   * @param {RunProgram.TS} serverData - The data to send
   * @param {number} timeout - The request timeout in ms
   */
  public execute(serverData: RunProgram.TSData, timeout = 30_000): void {
    const ws = new WebSocket(this.server);
    const ts: RunProgram.TS = {
      action: 'execute',
      data: serverData,
    };

    ws.addEventListener('open', function open() {
      ws.send(JSON.stringify(ts));
    });

    ws.addEventListener('message', (event) => {
      const fsData = JSON.parse(event.data);
      if ('connectionId' in fsData) {
        throw new Error('Executer gave server error: ' + event.data);
      }
      this.cb(fsData);
    });

    const connectionTimeout = setTimeout(function() {
      switch (ws.readyState) {
        case WebSocket.CONNECTING:
        case WebSocket.OPEN:
          ws.close();
          throw new Error(`Timeout: No response from server in ${timeout}ms`);
        default:
      }
    }, timeout);

    ws.addEventListener('close', function() {
      clearTimeout(connectionTimeout);
    });
  }

  /**
   * Delay function
   *
   * @param {number} ms - Number of milliseconds to delay-+
   * @return {Promise<unknown>} - A promise to await
   */
  public static delay(ms: number): Promise<unknown> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
