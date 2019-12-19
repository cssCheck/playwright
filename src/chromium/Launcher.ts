/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as URL from 'url';
import { Browser } from './Browser';
import { BrowserFetcher, BrowserFetcherOptions } from '../browserFetcher';
import { TimeoutError } from '../errors';
import { assert, helper } from '../helper';
import { ConnectionTransport, WebSocketTransport, PipeTransport, SlowMoTransport } from '../transport';
import * as util from 'util';
import { launchProcess, waitForLine } from '../processLauncher';

const mkdtempAsync = helper.promisify(fs.mkdtemp);

const CHROME_PROFILE_PATH = path.join(os.tmpdir(), 'playwright_dev_profile-');

const DEFAULT_ARGS = [
  '--disable-background-networking',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  // BlinkGenPropertyTrees disabled due to crbug.com/937609
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--enable-automation',
  '--password-store=basic',
  '--use-mock-keychain',
];

export class Launcher {
  private _projectRoot: string;
  private _preferredRevision: string;

  constructor(projectRoot: string, preferredRevision: string) {
    this._projectRoot = projectRoot;
    this._preferredRevision = preferredRevision;
  }

  async launch(options: (LauncherLaunchOptions & LauncherChromeArgOptions & ConnectionOptions) = {}): Promise<Browser> {
    const {
      ignoreDefaultArgs = false,
      args = [],
      dumpio = false,
      executablePath = null,
      pipe = false,
      env = process.env,
      handleSIGINT = true,
      handleSIGTERM = true,
      handleSIGHUP = true,
      slowMo = 0,
      timeout = 30000
    } = options;

    const chromeArguments = [];
    if (!ignoreDefaultArgs)
      chromeArguments.push(...this.defaultArgs(options));
    else if (Array.isArray(ignoreDefaultArgs))
      chromeArguments.push(...this.defaultArgs(options).filter(arg => ignoreDefaultArgs.indexOf(arg) === -1));
    else
      chromeArguments.push(...args);

    let temporaryUserDataDir: string | null = null;

    if (!chromeArguments.some(argument => argument.startsWith('--remote-debugging-')))
      chromeArguments.push(pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');
    if (!chromeArguments.some(arg => arg.startsWith('--user-data-dir'))) {
      temporaryUserDataDir = await mkdtempAsync(CHROME_PROFILE_PATH);
      chromeArguments.push(`--user-data-dir=${temporaryUserDataDir}`);
    }

    let chromeExecutable = executablePath;
    if (!executablePath) {
      const {missingText, executablePath} = this._resolveExecutablePath();
      if (missingText)
        throw new Error(missingText);
      chromeExecutable = executablePath;
    }

    const usePipe = chromeArguments.includes('--remote-debugging-pipe');

    const launchedProcess = await launchProcess({
      executablePath: chromeExecutable,
      args: chromeArguments,
      env,
      handleSIGINT,
      handleSIGTERM,
      handleSIGHUP,
      dumpio,
      pipe: usePipe,
      tempDir: temporaryUserDataDir
    }, () => {
      if (temporaryUserDataDir || !browser)
        return Promise.reject();
      return browser.close();
    });

    let browser: Browser | undefined;
    try {
      let transport: ConnectionTransport | null = null;
      let browserWSEndpoint: string = '';
      if (!usePipe) {
        const timeoutError = new TimeoutError(`Timed out after ${timeout} ms while trying to connect to Chrome! The only Chrome revision guaranteed to work is r${this._preferredRevision}`);
        const match = await waitForLine(launchedProcess, launchedProcess.stderr, /^DevTools listening on (ws:\/\/.*)$/, timeout, timeoutError);
        browserWSEndpoint = match[1];
        transport = await WebSocketTransport.create(browserWSEndpoint);
      } else {
        transport = new PipeTransport(launchedProcess.stdio[3] as NodeJS.WritableStream, launchedProcess.stdio[4] as NodeJS.ReadableStream);
      }
      browser = await Browser.create(browserWSEndpoint, SlowMoTransport.wrap(transport, slowMo), launchedProcess);
      await browser._waitForTarget(t => t.type() === 'page');
      return browser;
    } catch (e) {
      if (browser)
        await browser.close();
      throw e;
    }
  }

  defaultArgs(options: LauncherChromeArgOptions = {}): string[] {
    const {
      devtools = false,
      headless = !devtools,
      args = [],
      userDataDir = null
    } = options;
    const chromeArguments = [...DEFAULT_ARGS];
    if (userDataDir)
      chromeArguments.push(`--user-data-dir=${userDataDir}`);
    if (devtools)
      chromeArguments.push('--auto-open-devtools-for-tabs');
    if (headless) {
      chromeArguments.push(
          '--headless',
          '--hide-scrollbars',
          '--mute-audio'
      );
    }
    if (args.every(arg => arg.startsWith('-')))
      chromeArguments.push('about:blank');
    chromeArguments.push(...args);
    return chromeArguments;
  }

  executablePath(): string {
    return this._resolveExecutablePath().executablePath;
  }

  async connect(options: (ConnectionOptions & {
      browserWSEndpoint?: string;
      browserURL?: string;
      transport?: ConnectionTransport; })): Promise<Browser> {
    assert(Number(!!options.browserWSEndpoint) + Number(!!options.browserURL) + Number(!!options.transport) === 1, 'Exactly one of browserWSEndpoint, browserURL or transport must be passed to playwright.connect');

    let transport: ConnectionTransport | undefined;
    let connectionURL: string = '';
    if (options.transport) {
      transport = options.transport;
    } else if (options.browserWSEndpoint) {
      connectionURL = options.browserWSEndpoint;
      transport = await WebSocketTransport.create(options.browserWSEndpoint);
    } else if (options.browserURL) {
      connectionURL = await getWSEndpoint(options.browserURL);
      transport = await WebSocketTransport.create(connectionURL);
    }
    return Browser.create(connectionURL, SlowMoTransport.wrap(transport, options.slowMo), null);
  }

  _resolveExecutablePath(): { executablePath: string; missingText: string | null; } {
    const browserFetcher = createBrowserFetcher(this._projectRoot);
    const revisionInfo = browserFetcher.revisionInfo(this._preferredRevision);
    const missingText = !revisionInfo.local ? `Chromium revision is not downloaded. Run "npm install" or "yarn install"` : null;
    return {executablePath: revisionInfo.executablePath, missingText};
  }

}

function getWSEndpoint(browserURL: string): Promise<string> {
  let resolve: (url: string) => void;
  let reject: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });

  const endpointURL = URL.resolve(browserURL, '/json/version');
  const protocol = endpointURL.startsWith('https') ? https : http;
  const requestOptions = Object.assign(URL.parse(endpointURL), { method: 'GET' });
  const request = protocol.request(requestOptions, res => {
    let data = '';
    if (res.statusCode !== 200) {
      // Consume response data to free up memory.
      res.resume();
      reject(new Error('HTTP ' + res.statusCode));
      return;
    }
    res.setEncoding('utf8');
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data).webSocketDebuggerUrl));
  });

  request.on('error', reject);
  request.end();

  return promise.catch(e => {
    e.message = `Failed to fetch browser webSocket url from ${endpointURL}: ` + e.message;
    throw e;
  });
}

export type LauncherChromeArgOptions = {
   headless?: boolean,
   args?: string[],
   userDataDir?: string,
   devtools?: boolean,
};

export type LauncherLaunchOptions = {
   executablePath?: string,
   ignoreDefaultArgs?: boolean|string[],
   handleSIGINT?: boolean,
   handleSIGTERM?: boolean,
   handleSIGHUP?: boolean,
   timeout?: number,
   dumpio?: boolean,
   env?: {[key: string]: string} | undefined,
   pipe?: boolean,
};

export type ConnectionOptions = {
   slowMo?: number,
};

export function createBrowserFetcher(projectRoot: string, options: BrowserFetcherOptions = {}): BrowserFetcher {
  const downloadURLs = {
    linux: '%s/chromium-browser-snapshots/Linux_x64/%d/%s.zip',
    mac: '%s/chromium-browser-snapshots/Mac/%d/%s.zip',
    win32: '%s/chromium-browser-snapshots/Win/%d/%s.zip',
    win64: '%s/chromium-browser-snapshots/Win_x64/%d/%s.zip',
  };

  const defaultOptions = {
    path: path.join(projectRoot, '.local-chromium'),
    host: 'https://storage.googleapis.com',
    platform: (() => {
      const platform = os.platform();
      if (platform === 'darwin')
        return 'mac';
      if (platform === 'linux')
        return 'linux';
      if (platform === 'win32')
        return os.arch() === 'x64' ? 'win64' : 'win32';
      return platform;
    })()
  };
  options = {
    ...defaultOptions,
    ...options,
  };
  assert(!!(downloadURLs as any)[options.platform], 'Unsupported platform: ' + options.platform);

  return new BrowserFetcher(options.path, options.platform, (platform: string, revision: string) => {
    let archiveName = '';
    let executablePath = '';
    if (platform === 'linux') {
      archiveName = 'chrome-linux';
      executablePath = path.join(archiveName, 'chrome');
    } else if (platform === 'mac') {
      archiveName = 'chrome-mac';
      executablePath = path.join(archiveName, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    } else if (platform === 'win32' || platform === 'win64') {
      // Windows archive name changed at r591479.
      archiveName = parseInt(revision, 10) > 591479 ? 'chrome-win' : 'chrome-win32';
      executablePath = path.join(archiveName, 'chrome.exe');
    }
    return {
      downloadUrl: util.format((downloadURLs as any)[platform], options.host, revision, archiveName),
      executablePath
    };
  });
}
