import { Frame, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { RecordingUploadFailedError, WaitingAtLobbyRetryError } from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext, { isExternalBrowserContext } from '../lib/chromium';
import { uploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZOOM_REQUEST_DENIED } from '../constants';

class BotBase extends AbstractMeetBot {
  protected page: Page;
  protected slightlySecretId: symbol; // Use any hard-to-guess identifier
  protected _logger: Logger;
  protected _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = Symbol(v4());
    this._logger = logger;
    this._correlationId = correlationId;
  }
  join(params: JoinParams): Promise<void> {
    throw new Error('Function not implemented.');
  }
}

export class ZoomBot extends BotBase {
  constructor(logger: Logger, correlationId: string) {
    super(logger, correlationId);
  }

  // Debug screenshots must never kill the join: page.screenshot's default 30s
  // timeout once took down a whole attempt when the renderer was busy, so cap
  // it short and swallow failures.
  private async captureDebugScreenshot(name: string, userId: string, botId?: string): Promise<void> {
    try {
      const buffer = await this.page.screenshot({ type: 'png', fullPage: true, timeout: 5000 });
      await uploadDebugImage(buffer, name, userId, this._logger, botId);
    } catch (err) {
      this._logger.warn(`Debug screenshot failed (non-fatal): ${name}`, { error: (err as Error)?.message ?? err });
    }
  }

  // TODO use base class for shared functions such as bot status and bot logging
  // TODO Lift the JoinParams to the constructor argument
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };
    
    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader });
      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
        throw new RecordingUploadFailedError('Zoom recording completed but upload failed');
      }
    } catch(error) {
      if (!_state.includes('finished') && !_state.includes('failed'))
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'zoom', error }, this._logger);
      }

      throw error;
    } finally {
      // Guarantee chrome subprocess tree is reaped regardless of exit path.
      // No-op if a deeper code path already closed the browser.
      try {
        const context = this.page?.context();
        const browser = context?.browser();
        if (isExternalBrowserContext(context)) {
          await this.page?.close();
          this._logger.info('External browser page closed in join finally');
        } else if (browser?.isConnected()) {
          await browser.close();
          this._logger.info('Browser closed in join finally');
        } else if (context) {
          await context.close();
          this._logger.info('Persistent browser context closed in join finally');
        }
      } catch (cleanupErr) {
        this._logger.warn('Browser cleanup in join finally failed (non-fatal)', { error: cleanupErr });
      }
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name } = params;
    this._logger.info('Launching browser for Zoom...', { userId: params.userId });

    this.page = await createBrowserContext(url, this._correlationId, 'zoom');

    await this.page.route('**/*.exe', (route) => {
      this._logger.info(`Detected .exe download: ${route.request().url()?.split('download')[0]}`);
    });

    this._logger.info('Navigating to Zoom Meeting URL...');
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    // Accept cookies
    try {
      this._logger.info('Waiting for the "Accept Cookies" button...');
      const acceptCookies = this.page.locator('button', { hasText: 'Accept Cookies' }).first();
      await acceptCookies.waitFor({ timeout: 2500 });

      this._logger.info('Clicking the "Accept Cookies" button...', await acceptCookies.count());
      await acceptCookies.click({ force: true });
      
    } catch (error) {
      this._logger.info('Unable to accept cookies...', error);
    }

    const hasFocus = await this.page.evaluate(() => document.hasFocus());
    this._logger.info(`Page focus status: ${hasFocus}`);

    const attempts = 3;
    let usingDirectWebClient = false;
    const findAndEnableJoinFromBrowserButton = async (retry: number): Promise<boolean> => {
      try {
        if (retry >= attempts) {
          return false;
        }

        // Zoom's current landing page shows a "Join from browser" button right
        // away (older UI: an <a> "Join from your browser" revealed only after
        // clicking Download Now). Check for it first — clicking Download Now on
        // the new UI just opens junk /download tabs in the shared browser.
        const directJoinFromBrowser = this.page
          .locator('a, button')
          .filter({ hasText: /Join from (your )?browser/i })
          .first();
        if (await directJoinFromBrowser.isVisible({ timeout: 1000 }).catch(() => false)) {
          this._logger.info('Join from browser button is directly visible, clicking...');
          await directJoinFromBrowser.click({ force: true });
          return true;
        }

        const launchMeetingGetByRole = this.page.getByRole('button', { name: /Launch Meeting/i }).first();
        this._logger.info('Does Launch Meeting exist', await launchMeetingGetByRole.isVisible({ timeout: 1000 }).catch(() => false));

        const launchDownloadGetByRole = this.page.getByRole('button', { name: /Download Now/i }).first();
        const launchDownloadVisible = await launchDownloadGetByRole.isVisible({ timeout: 1000 }).catch(() => false);
        this._logger.info('Does Download Now exist', launchDownloadVisible);

        if (launchDownloadVisible) {
          this._logger.info('Click on Download Now...');
          await launchDownloadGetByRole.click({ force: true });
        }

        const joinFromBrowser = this.page.locator('a, button').filter({ hasText: /Join from (your )?browser/i }).first();
        await joinFromBrowser.waitFor({ timeout: 4000 });

        if (await joinFromBrowser.isVisible({ timeout: 500 }).catch(() => false)) {
          await joinFromBrowser.click({ force: true });
          return true;
        }
        else {
          this._logger.info('Try to find the Join from your browser button again...', retry + 1);
          return await findAndEnableJoinFromBrowserButton(retry + 1);
        }
      } catch(error) {
        this._logger.info('Error on try find the web client', error);
        if (retry >= attempts) {
          return false;
        }
        return await findAndEnableJoinFromBrowserButton(retry + 1);
      }
    };

    const visitWebClientByUrl = async (): Promise<boolean> => {
      usingDirectWebClient = true;
      try {
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        this._logger.info('Navigating to Zoom Web Client URL...', { wcUrl: wcUrl.toString(), botId: params.botId, userId: params.userId });
        await this.page.goto(wcUrl.toString(), { waitUntil: 'domcontentloaded' });
        return true;
      } catch(err) {
        usingDirectWebClient = false;
        this._logger.info('Failed to access ZOOM web client by URL', { botId: params.botId, userId: params.userId });
        return false;
      }
    };

    const waitForJoinFromBrowserNav = async (): Promise<boolean> => {
      try {
        const maxAttempts = 10;
        let attempt = 0;

        const navPromise = new Promise<boolean>((foundResolver) => {
          const interv = setInterval(async () => {
            if (attempt >= maxAttempts) {
              clearInterval(interv);
              foundResolver(false);
              return;
            }

            try {
              const joinFromBrowser = this.page.locator('a, button').filter({ hasText: /Join from (your )?browser/i }).first();
              if (await joinFromBrowser.isVisible({ timeout: 500 }).catch(() => false)) {
                this._logger.info('Waiting for zoom navigation to meeting page...', params.userId);
              }
              else {
                clearInterval(interv);
                foundResolver(true);
              }
            }
            catch(e) {
              if (e?.name === 'TimeoutError') {
                this._logger.info('Join from your browser is no longer present on page...', params.userId);
                clearInterval(interv);
                foundResolver(true);
                return;
              }
              this._logger.info('An error happened while waiting for zoom navigation to finish', e);
              if (attempt >= maxAttempts) {
                clearInterval(interv);
                foundResolver(false);
                return;
              }
            }
            attempt += 1;
          }, 1000);
        });
        const success = await navPromise;
        return success;
      } catch(err) {
        this._logger.info('Zoom error: Unable to move forward from Join from your browser', params.userId);
        return false;
      }
    };

    // The direct /wc/join URL is the most deterministic route into the web
    // client. The landing page's "Join from browser" button is unreliable under
    // automation (its click sometimes silently never navigates), so go by URL
    // first and keep the button dance as a fallback.
    this._logger.info('Navigating directly to the Zoom Web Client URL...');
    const canAccess = await visitWebClientByUrl();

    if (!canAccess) {
      this._logger.info('Direct web client access failed; falling back to the Join from browser button...', params.userId);
      const foundAndClickedJoinFromBrowser = await findAndEnableJoinFromBrowserButton(0);

      let navSuccess = false;
      if (foundAndClickedJoinFromBrowser) {
        this._logger.info('Verify the meeting web client is visible...');
        // Ensure the page has navigated to the web client...
        navSuccess = await waitForJoinFromBrowserNav();
      }

      if (!foundAndClickedJoinFromBrowser || !navSuccess) {
        await this.captureDebugScreenshot('enable-join-from-browser', params.userId, params.botId);
        throw new Error('Unable to join meeting after trying to access the web client by /wc/join/ and the Join from browser button');
      }
    }

    this._logger.info('Heading to the web client...', { usingDirectWebClient });

    let iframe: Frame | Page = this.page;
    const apps: ('app' | 'iframe')[] = [];
    const detectAppContainer = async (startWith: 'app' | 'iframe'): Promise<boolean> => {
      try {
        if (apps.includes('app') && apps.includes('iframe')) {
          return false;
        }

        apps.push(startWith);
        if (startWith === 'app') {
          const input = await this.page.waitForSelector('input[type="text"]', { timeout: 30000 });
          const join = this.page.locator('button', { hasText: /Join/i }).first();
          await join.waitFor({ timeout: 15000 });
          this._logger.info('App container...', { input: input !== null, join: join !== null });
          if (input && join) {
            iframe = this.page;
          } else {
            return await detectAppContainer('iframe');
          }
        }

        if (startWith === 'iframe') {
          const iframeElementHandle = await this.page.waitForSelector('iframe#webclient', { timeout: 30000, state: 'attached' });
          this._logger.info('Iframe container...', await iframeElementHandle?.getAttribute('id'));
          const contentFrame = await iframeElementHandle.contentFrame();
          if (contentFrame) {
            iframe = contentFrame;
          } else {
            return await detectAppContainer('app');
          }
        }

        return true;
      } catch(err) {
        this._logger.info('Cannot detect the App container for Zoom Web Client', startWith, err);
        await this.captureDebugScreenshot('detect-app-container', params.userId, params.botId);
        return await detectAppContainer(startWith === 'app' ? 'iframe' : 'app');
      }
    };

    const foundAppContainer = await detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');

    if (!iframe || !foundAppContainer) {
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    this._logger.info('Waiting for the input field to be visible...');
    await iframe.waitForSelector('input[type="text"]', { timeout: 60000 });

    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    // Zoom's newer web client covers the pre-join form with a "Do you want
    // people to see you in the meeting?" modal, which blocks the Join button.
    // The bot records via tab capture and never needs mic/camera, so dismiss it
    // the same way the Google Meet bot does: continue without devices.
    const dismissDevicePreferenceModal = async (timeout: number): Promise<boolean> => {
      const continueWithoutDevices = iframe
        .locator('button, a, [role="button"]')
        .filter({ hasText: /Continue without (microphone|mic)( and camera)?/i })
        .first();
      try {
        await continueWithoutDevices.waitFor({ state: 'visible', timeout });
        this._logger.info('Device preference modal found; continuing without microphone and camera...');
        await continueWithoutDevices.click();
        return true;
      } catch {
        return false;
      }
    };

    if (!(await dismissDevicePreferenceModal(5000))) {
      this._logger.info('No device preference modal detected, continuing...');
    }

    this._logger.info('Clicking the "Join" button...');
    const joinButton = iframe.locator('button', { hasText: 'Join' }).first();
    await joinButton.waitFor({ timeout: 15000 });
    try {
      await joinButton.click({ timeout: 15000 });
    } catch (firstClickErr) {
      // The modal can also appear late (after the first dismissal window) — if
      // something blocked the click, try dismissing it once more before failing.
      this._logger.warn('Join click blocked; re-checking for the device preference modal...', { error: (firstClickErr as Error)?.message });
      const dismissedLate = await dismissDevicePreferenceModal(2000);
      try {
        await joinButton.click({ timeout: dismissedLate ? 15000 : 5000 });
      } catch (clickErr) {
        // The button was visible but never became clickable — usually an overlay
        // (bot-detection notice, captcha, permission dialog) or a disabled state.
        // Capture what the page actually showed so the blocker is identifiable.
        const bodyText = await iframe.evaluate(() => document.body.innerText).catch(() => '<unavailable>');
        this._logger.error('Join click failed; page text at failure time', { bodyText });
        await this.captureDebugScreenshot('join-click-failed', params.userId, params.botId);
        throw clickErr;
      }
    }

    // Wait in waiting room
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      const waitAtLobbyPromise = new Promise<boolean>((resolveMe) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveMe(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const footerInfo = await iframe.locator('#wc-footer');
            await footerInfo.waitFor({ state: 'attached' });
            const footerText = await footerInfo?.innerText();

            const tokens1 = footerText.split('\n');
            const tokens2 = footerText.split(' ');
            const tokens = tokens1.length > tokens2.length ? tokens1 : tokens2;
  
            const filtered: string[] = [];
            for (const tok of tokens) {
              if (!tok) continue;
              if (!Number.isNaN(Number(tok.trim())))
                filtered.push(tok);
              else if (tok.trim().toLowerCase() === 'participants') {
                filtered.push(tok.trim().toLowerCase());
                break;
              }
            }
            const joinedText = filtered.join('');

            if (joinedText === 'participants') 
              return;

            const isValid = joinedText.match(/\d+(.*)participants/i);
            if (!isValid) {
              return;
            }

            const num = joinedText.match(/\d+/);
            this._logger.info('Final Number of participants while waiting...', num);
            if (num && Number(num[0]) === 0)
              this._logger.info('Waiting on host...');
            else {
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveMe(true);
            }
          } catch(e) {
            // Do nothing
          }
        }, 2000);
      });

      const joined = await waitAtLobbyPromise;
      if (!joined) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(ZOOM_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: joined, bodyText });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError('Zoom bot could not enter the meeting...', bodyText ?? '', false, 0);
      }

      this._logger.info('Bot is entering the meeting after wait room...');
    } catch (error) {
      this._logger.info('Closing the browser on error...', error);
      if (isExternalBrowserContext(this.page.context())) {
        await this.page.close();
      } else {
        await this.page.context().browser()?.close();
      }

      throw error;
    }

    // Wait for device notifications and close the notifications
    let notifyInternval: NodeJS.Timeout;
    let notifyTimeout: NodeJS.Timeout;
    try {
      const cameraNotifications: ('found' | 'dismissed')[] = [];
      const micNotifications: ('found' | 'dismissed')[] = [];
      const stopWaiting = 6 * 1000;
      let sawNotification = false;
      
      const notifyPromise = new Promise<boolean>((res) => {
        notifyTimeout = setTimeout(() => {
          clearInterval(notifyInternval);
          res(false);
        }, stopWaiting);
        notifyInternval = setInterval(async () => {
          try {
            const cameraDiv = iframe.locator('div', { hasText: /^Cannot detect your camera/i }).first();
            const micDiv = iframe.locator('div', { hasText: /^Cannot detect your microphone/i }).first();
            const cameraVisible = await cameraDiv.isVisible({ timeout: 500 }).catch(() => false);
            const micVisible = await micDiv.isVisible({ timeout: 500 }).catch(() => false);

            if (!cameraVisible && !micVisible && !sawNotification) {
              clearInterval(notifyInternval);
              clearTimeout(notifyTimeout);
              res(false);
              return;
            }

            if (cameraVisible) {
              sawNotification = true;
              if (!cameraNotifications.includes('found'))
                cameraNotifications.push('found');
            }
            else {
              if (cameraNotifications.includes('found'))
                cameraNotifications.push('dismissed');
            }

            if (micVisible) {
              sawNotification = true;
              if (!micNotifications.includes('found'))
                micNotifications.push('found');
            }
            else {
              if (micNotifications.includes('found'))
                micNotifications.push('dismissed');
            }

            if (micNotifications.length >= 2 && cameraNotifications.length >= 2) {
              clearInterval(notifyInternval);
              clearTimeout(notifyTimeout);
              res(true);
              return;
            }

            const closeButtons = await iframe.getByLabel('close').all();
            this._logger.info('Clicking the "x" button...', closeButtons.length);
            
            let counter = 0;
            try {
              for await (const close of closeButtons) {
                if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
                  await close.click({ timeout: 1000 });
                  counter += 1;
                }
              }
            } catch (err) {
              this._logger.info('Unable to click the x notifications', counter, err);
            }
          } catch (error) {
            // Log and ignore this error
            this._logger.info('Unable to close x notifications...', error);
            clearInterval(notifyInternval);
            clearTimeout(notifyTimeout);
            res(false);
          }
        }, 1000);
      });

      await notifyPromise.catch(() => {
        clearInterval(notifyInternval);
        clearTimeout(notifyTimeout);
      });
    }
    catch(err) {
      this._logger.info('Caught notifications close error', err.message);
    }

    // Dismiss annoucements OK button if present
    try {
      const okButton = iframe.locator('button', { hasText: 'OK' }).first();
      if (await okButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await okButton.click({ timeout: 1000 });
        this._logger.info('Dismissed the OK button...');
      }
    } catch (error) {
      this._logger.info('OK button might be missing...', error);
    }

    pushState('joined');

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ ...params });
    
    pushState('finished');
  }

  private async recordMeetingPage(params: JoinParams): Promise<void> {
    const { teamId, userId, eventId, botId, uploader } = params;
    const duration = config.maxRecordingDuration * 60 * 1000;

    this._logger.info('Setting up the duration');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    this._logger.info('Setting up the recording connect functions');
    const chores = new ContextBridgeTask(
      this.page, 
      { ...params, botId: params.botId ?? '' },
      this.slightlySecretId.toString(),
      waitingPromise,
      uploader,
      this._logger
    );
    await chores.runAsync(null);

    this._logger.info('Setting up the recording Main Task');
    // Inject the MediaRecorder code into the browser context using page.evaluate
    const recordingTask = new RecordingTask(
      userId,
      teamId,
      this.page,
      duration,
      this.slightlySecretId.toString(),
      this._logger
    );
    await recordingTask.runAsync(null);
  
    this._logger.info('Waiting for recording duration:', config.maxRecordingDuration, 'minutes...');
    waitingPromise.promise.then(async () => {
      const context = this.page.context();
      // For the external chrome-cdp sidecar, browser.close() only disconnects
      // Playwright — the Zoom tab would stay open and the bot would linger in
      // the meeting. Close the tab instead; the shared Chrome stays up for the
      // next job.
      if (isExternalBrowserContext(context)) {
        this._logger.info('Closing the page (external CDP browser stays up)...');
        await this.page.close();
      } else {
        this._logger.info('Closing the browser...');
        await context.browser()?.close();
      }

      this._logger.info('Recording stopped; finalizing upload next...', { botId, eventId, userId, teamId });
    });
    await waitingPromise.promise;
  }
}
