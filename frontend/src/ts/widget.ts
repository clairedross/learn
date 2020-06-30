import {Area, OutputArea, LabContainer} from './areas';
import {Button, CheckBox, Tabs} from './components';
import {Editor, EditorTheme} from './editor';
import {fetchJSON, fetchBlob, DownloadRequest, DownloadResponse} from './comms';
import {Resource, RunProgram, CheckOutput} from './types';
import * as Strings from './strings';
import * as util from './utilities';

enum DownloadType {
  None,
  Client,
  Server,
}

/** The Widget class */
class Widget {
  private editors: Array<Editor> = [];
  protected readonly container: HTMLElement;
  private readonly name: string;
  private tabs: Tabs = new Tabs();
  protected outputArea: OutputArea = new OutputArea();

  private buttons: Array<Button> = [];
  private buttonsDisabled = false;

  protected lab = false;

  private dlType: DownloadType = DownloadType.Client;

  private readonly server: string;

  private shadowFiles: Array<Resource> = [];

  protected buttonGroup: HTMLElement;
  protected outputGroup: HTMLElement;

  /**
   * Constructs the Widget
   * @param {HTMLElement} container - the container for the widget
   * @param {string} server - the server address:port
   */
  constructor(container: HTMLElement, server: string) {
    const resources: Array<Resource> = [];
    this.server = server;
    this.container = container;

    // Read attributes from container object to initialize members
    this.name = container.getAttribute('name');

    const files = this.container.getElementsByClassName('file');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const a: Resource = {basename: file.getAttribute('basename'),
        contents: file.textContent};
      file.textContent = '';
      resources.push(a);
    }

    const shadowFiles = this.container.getElementsByClassName('shadow_file');
    for (let i = 0; i < shadowFiles.length; i++) {
      const file = shadowFiles[i];
      const a: Resource = {basename: file.getAttribute('basename'),
        contents: file.textContent};
      file.textContent = '';
      this.shadowFiles.push(a);
    }

    // fill the contents of the tabs
    resources.map((file) => {
      const ed = new Editor(file);
      this.editors.push(ed);

      const tab = this.tabs.addTab(file.basename, ed.render(), () => {
        const lengths = this.editors.map((e) => e.getLength());
        // This is a new one: ... is a spread operator
        const max = Math.max(...lengths);
        ed.setLength(max);
      });
      ed.setTab(tab);
    });

    // Check which buttons are enabled on container and populate
    for (const mode in Strings.modeDictionary) {
      if (this.container.getAttribute(mode + '_button')) {
        this.addButton(mode);
      }
    }

    // if this widget doesn't have a name defined, don't allow for download
    if (util.isUndefined(this.name)) {
      this.dlType = DownloadType.None;
    }
  }

  /**
   * Add a button to the button list
   * @param {string} mode - the mode of button to add
   */
  protected addButton(mode: string): void {
    // if there are any buttons, the dltype needs to be server
    this.dlType = DownloadType.Server;

    const btn: Button = new Button([],
        Strings.modeDictionary[mode].tooltip,
        Strings.modeDictionary[mode].buttonText);
    btn.registerEvent('click', async () => {
      if (this.buttonsDisabled) {
        return;
      }
      this.buttonsDisabled = true;
      try {
        await this.buttonCB(mode);
      } catch (error) {
        this.outputArea.addError(Strings.MACHINE_BUSY_LABEL);
        console.error('Error:', error);
      } finally {
        this.buttonsDisabled = false;
      }
    });

    this.buttons.push(btn);
  }

  /**
   * Collect the resources loaded in the widget and return as list
   * @return {Array<Resource>} return the widget resources
   */
  protected collectResources(): Array<Resource> {
    const files: Array<Resource> = [];
    this.editors.map((e) => {
      files.push(e.getResource());
    });
    return files.concat(this.shadowFiles);
  }

  /**
   * Construct the server address string
   * @param {string} url - the url suffix
   * @return {string} - the full constructed url
   */
  private serverAddress(url: string): string {
    return this.server + '/' + url + '/';
  }

  /**
   * The main callback for the widget buttons
   * @param {string} mode - the mode of the button that triggered the event
   */
  protected async buttonCB(mode: string): Promise<void> {
    this.outputArea.reset();

    this.outputArea.add(['output_info', 'console_output'],
        Strings.CONSOLE_OUTPUT_LABEL + ':');
    this.outputArea.showSpinner(true);

    const files: Array<Resource> = this.collectResources();

    const serverData: RunProgram.TS = {
      files: files,
      mode: mode,
      name: this.name,
      lab: this.lab,
    };

    try {
      const json =
        await
        fetchJSON<RunProgram.TS, RunProgram.FS>(serverData,
            this.serverAddress('run_program'));
      if (json.identifier == '') {
        throw new Error(json.message);
      }

      await this.getOutputFromIdentifier(json);
    } finally {
      this.outputArea.showSpinner(false);
    }
  }

  /**
   * The download example callback
   */
  private async downloadExample(): Promise<Array<DownloadResponse>> {
    const files: Array<Resource> = this.collectResources();
    const blobList: Array<DownloadResponse> = [];

    switch (this.dlType) {
      case DownloadType.None: {
        throw new Error('No download available for this exercise.');
      }
      case DownloadType.Server: {
        const serverData: DownloadRequest = {
          files: files,
          name: this.name,
        };

        const ret = await fetchBlob(serverData,
            this.serverAddress('download'));
        blobList.push(ret);

        break;
      }
      case DownloadType.Client: {
        this.editors.map((e): void => {
          const resource: Resource = e.getResource();

          blobList.push({
            blob: new Blob([resource.contents], {type: 'text/plain'}),
            filename: resource.basename,
          });
        });
        break;
      }
    }

    return blobList;
  }

  /**
   * Get the run output using the return identifier from the button CB
   * @param {RunProgram.FS} json - the json data returned from button CB
   * @param {number} lRead - the number of lines already read from the stream
   * @param {number} nReq - the number of requests sent
   */
  private async getOutputFromIdentifier(json: RunProgram.FS,
      lRead = 0, nReq = 0): Promise<void> {
    const data: CheckOutput.TS = {
      identifier: json.identifier,
      read: lRead,
    };

    const rdata =
      await fetchJSON<CheckOutput.TS, CheckOutput.FS>(data,
          this.serverAddress('check_output'));

    if (nReq > 200) {
      throw new Error('Request timed out. ' + Strings.INTERNAL_ERROR_MESSAGE);
    } else {
      nReq++;
    }

    lRead += this.processCheckOutput(rdata);

    if (!rdata.completed) {
      // We have not finished processing the output: call this again
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.getOutputFromIdentifier(json, lRead, nReq);
    }
  }

  /**
   * Returns the correct Area to place data in
   * @param {number} ref - should be null for Widget
   * @return {Area} the area to place returned data
   */
  protected getHomeArea(ref: number): Area {
    if (ref != null) {
      throw new Error('Malformed data packet has ref in non-lab.');
    }
    return this.outputArea;
  }

  /**
   * Handle the msg data coming back from server
   * @param {CheckOutput.RunMsg} msg - the returned msg
   * @param {Area} homeArea - the area to place the rendered msg
   */
  protected handleMsgType(msg: CheckOutput.RunMsg, homeArea: Area): void {
    switch (msg.type) {
      case 'console': {
        homeArea.addConsole(msg.data);
        break;
      }
      case 'internal_error':
        msg.data += ' ' + Strings.INTERNAL_ERROR_MESSAGE;
        // Intentional: fall through
      case 'stderr':
      case 'stdout': {
        const outMsg = msg.data;
        const ctRegex = /^([a-zA-Z._0-9-]+):(\d+):(\d+):(.+)$/m;
        const rtRegex = /^raised .+ : ([a-zA-Z._0-9-]+):(\d+) (.+)$/m;

        const ctMatchFound: Array<string> = outMsg.match(ctRegex);
        const rtMatchFound: Array<string> = outMsg.match(rtRegex);

        if (ctMatchFound || rtMatchFound) {
          let basename: string;
          let row: number;
          let col: number;

          // Lines that contain a sloc are clickable:
          const cb = (): void => {
            if (window.getSelection().toString() == '') {
              this.editors.map((e) => {
                if (basename == e.getResource().basename) {
                  // Switch to the tab that contains the editor
                  e.getTab().click();

                  // Jump to the corresponding line
                  e.gotoLine(row, col);
                }
              });
            }
          };

          if (ctMatchFound) {
            basename = ctMatchFound[1];
            row = parseInt(ctMatchFound[2]);
            col = parseInt(ctMatchFound[3]);

            if (ctMatchFound[4].indexOf(' info:') == 0) {
              homeArea.addInfo(outMsg, cb);
            } else {
              homeArea.addMsg(outMsg, cb);
              homeArea.errorCount++;
            }
          } else {
            basename = rtMatchFound[1];
            row = parseInt(rtMatchFound[2]);
            col = 1;

            homeArea.addMsg(outMsg, cb);
            homeArea.errorCount++;
          }
        } else {
          homeArea.addLine(outMsg);
        }
        break;
      }
      default: {
        homeArea.addLine(msg.data);
        throw new Error('Unhandled msg type.');
        break;
      }
    }
  }

  /**
   * Process the output from "check_output" ajax request
   * @param {CheckOutput.FS} data - The data from check_output
   * @return {number} the number of lines read by this function
   */
  private processCheckOutput(data: CheckOutput.FS): number {
    let readLines = 0;

    data.output.map((ol) => {
      const homeArea = this.getHomeArea(ol.ref);
      readLines++;

      this.handleMsgType(ol.msg, homeArea);
    });

    if (data.completed) {
      this.buttons.map((b) => {
        b.disabled = false;
      });

      if (data.status != 0) {
        this.outputArea.addError(Strings.EXIT_STATUS_LABEL +
            ': ' + data.status);
      }
    }

    return readLines;
  }

  /**
   * Reset the editors, outputArea
   */
  protected resetEditors(): void {
    this.outputArea.reset();

    this.editors.map((e) => {
      e.reset();
    });
  }

  /**
   * Render the settings bar for the widget
   * @return {HTMLElement} the rendered settings bar
   */
  private renderSettingsBar(): HTMLElement {
    const settingsBar = document.createElement('div');
    settingsBar.classList.add('settings-bar');

    const dropdownContainer = document.createElement('div');
    dropdownContainer.classList.add('dropdown-container', 'settingsbar-item');
    settingsBar.appendChild(dropdownContainer);

    const dropdownButton = document.createElement('button');
    dropdownButton.classList.add('dropdown-btn');
    dropdownButton.innerHTML = '<i class="fas fa-cog"></i>';
    dropdownContainer.appendChild(dropdownButton);

    const dropdownContent = document.createElement('div');
    dropdownContent.classList.add('dropdown-content');
    dropdownContainer.appendChild(dropdownContent);

    const tabSetting =
        new CheckBox(Strings.SETTINGS_TABBED_EDITOR_LABEL, dropdownContent);
    tabSetting.getCheckBox().checked = true;
    tabSetting.getCheckBox().addEventListener('change', () => {
      if (tabSetting.checked()) {
        this.tabs.show(true);
      } else {
        this.tabs.show(false);
      }
    });

    const themeSetting =
        new CheckBox(Strings.SETTINGS_THEME_EDITOR_LABEL, dropdownContent);

    themeSetting.getCheckBox().addEventListener('change', () => {
      let theme = EditorTheme.Light;
      if (themeSetting.checked()) {
        theme = EditorTheme.Dark;
      }
      this.editors.map((e) => {
        e.setTheme(theme);
      });
    });

    const resetButton = document.createElement('button');
    resetButton.setAttribute('type', 'button');
    resetButton.classList.add('settingsbar-item', 'reset-btn');
    resetButton.setAttribute('title', Strings.RESET_TOOLTIP);
    resetButton.innerHTML = '<i class="fas fa-undo"></i>';
    settingsBar.appendChild(resetButton);
    resetButton.addEventListener('click', () => {
      if (window.confirm(Strings.RESET_CONFIRM_MSG)) {
        this.resetEditors();
      }
    });

    if (this.dlType != DownloadType.None) {
      const dlButton = document.createElement('button');
      dlButton.setAttribute('type', 'button');
      dlButton.classList.add('settingsbar-item', 'download-btn');
      dlButton.setAttribute('title', Strings.DOWNLOAD_TOOLTIP);
      dlButton.innerHTML = '<i class="fas fa-file-download"></i>';
      settingsBar.appendChild(dlButton);
      dlButton.addEventListener('click', async () => {
        try {
          const blobs = await this.downloadExample();

          for (const blob of blobs) {
            const objURL: string = URL.createObjectURL(blob.blob);

            const a = document.createElement('a');
            a.setAttribute('href', objURL);
            a.setAttribute('download', blob.filename);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(objURL);
          }
        } catch (error) {
          this.outputArea.reset();
          this.outputArea.addError(Strings.MACHINE_BUSY_LABEL);
          console.error('Error:', error);
        }
      });
    }

    return settingsBar;
  }

  /**
   * Render the widget by putting it into this.container
   */
  public render(): void {
    this.tabs.render(this.container);
    this.container.appendChild(this.renderSettingsBar());

    const row = document.createElement('div');
    row.classList.add('row', 'output_row');
    this.container.appendChild(row);

    this.buttonGroup = document.createElement('div');
    this.buttonGroup.classList.add('col-md-3');
    row.appendChild(this.buttonGroup);

    this.buttons.map((b) => {
      this.buttonGroup.appendChild(b.render());
    });

    this.outputGroup = document.createElement('div');
    this.outputGroup.classList.add('col-md-9');
    this.outputGroup.appendChild(this.outputArea.render());
    row.appendChild(this.outputGroup);
  }
}

/**
 * The LabWidget class
 * @extends Widget
 */
class LabWidget extends Widget {
  private readonly labContainer: LabContainer = new LabContainer;

  /**
   * Constructs the LabWidget
   * @param {HTMLElement} container - the container for the widget
   * @param {string} server - the server address:port
   */
  constructor(container: HTMLElement, server: string) {
    super(container, server);

    this.addButton('submit');

    this.lab = true;
  }

  /**
   * The main callback for the widget buttons
   * @param {string} mode - the mode of the button that triggered the event
   */
  protected async buttonCB(mode: string): Promise<void> {
    this.labContainer.reset();

    await super.buttonCB(mode);

    this.labContainer.sort();
  }

  /**
   * Returns the correct Area to place data in
   * @param {number} ref - if not null, the lab ref
   * @return {Area} the area to place returned data
   */
  protected getHomeArea(ref: number): Area {
    if (ref != null) {
      return this.labContainer.getLabArea(ref);
    }
    return this.outputArea;
  }

  /**
   * Handle the msg data coming back from server
   * @param {CheckOutput.RunMsg} msg - the returned msg
   * @param {Area} homeArea - the area to place the rendered msg
   */
  protected handleMsgType(msg: CheckOutput.RunMsg, homeArea: Area): void {
    switch (msg.type) {
      case 'lab': {
        const result =
          this.labContainer.processResults(
              (msg.data as unknown) as CheckOutput.LabOutput);
        this.outputArea.addLabStatus(result);
        break;
      }
      default: {
        super.handleMsgType(msg, homeArea);
      }
    }
  }

  /**
   * Reset the editors, outputArea, and labContainer
   */
  protected resetEditors(): void {
    super.resetEditors();
    this.labContainer.reset();
  }

  /**
   * Render the widget by putting it into this.container
   */
  public render(): void {
    super.render();
    const lc = this.labContainer.render();
    this.outputGroup.appendChild(lc);
  }
}

/**
 * Entrypoint for widget creation
 *
 * @export
 * @param {HTMLCollectionOf<Element>} widgets - The collection of widgets
 *    found on the page. This is the return value of getElementsByClass
 * @return {Array<Widget | LabWidget>} The list of widgets on the page
 */
export function widgetFactory(widgets: HTMLCollectionOf<Element>):
    Array<Widget | LabWidget> {
  const widgetList = [];
  for (let i = 0; i < widgets.length; i++) {
    const element = (widgets[i] as HTMLElement);
    const server = element.getAttribute('example_server');

    if (server) {
      const lab = element.getAttribute('lab');
      const widget =
          lab ? new LabWidget(element, server) : new Widget(element, server);
      widget.render();
      widgetList.push(widget);
    } else {
      throw Error('Malformed widget! No server address specified.');
    }
  }

  return widgetList;
}
