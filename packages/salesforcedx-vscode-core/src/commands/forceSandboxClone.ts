/*
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  CliCommandExecutor,
  Command,
  OrgCreateErrorResult,
  OrgCreateResultParser,
  SfdxCommandBuilder
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import {
  isAlphaNumSpaceString,
  isIntegerInRange
} from '@salesforce/salesforcedx-utils-vscode/out/src/helpers';
import {
  CancelResponse,
  ContinueResponse,
  ParametersGatherer
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as path from 'path';
import * as vscode from 'vscode';
import { channelService } from '../channels';
import { OrgType, setWorkspaceOrgTypeWithOrgType } from '../context';
import { nls } from '../messages';
import { notificationService, ProgressNotification } from '../notifications';
import { taskViewService } from '../statuses';
import { telemetryService } from '../telemetry';
import {
  getRootWorkspace,
  getRootWorkspacePath,
  hasRootWorkspace
} from '../util';
import {
  CompositeParametersGatherer,
  CompositePreconditionChecker,
  DevUsernameChecker,
  FileSelection,
  SfdxCommandlet,
  SfdxCommandletExecutor,
  SfdxWorkspaceChecker
} from './util';

export const DEFAULT_ALIAS = 'vscodeSandbox';
export const DEFAULT_WAIT_TIME_MINS = '30';

export class ForceSandboxCloneExecutor extends SfdxCommandletExecutor<
  AliasAndFileSelection
  > {
  public build(data: AliasAndFileSelection): Command {
    return new SfdxCommandBuilder()
      .withDescription(
        nls.localize('force_sandbox_clone')
      )
      .withArg('force:org:clone')
      .withFlag('--type', 'sandbox')
      .withFlag('-a', data.alias)
      .withFlag('-w', data.waitTime)
      .withArg(`SourceSandboxName=${data.sourceSandbox}`)
      .withArg(`sandboxName=${data.sandboxName}`)
      .withLogName('force_org_clone_sandbox_org')
      .withJson()
      .build();
  }

  public execute(response: ContinueResponse<AliasAndFileSelection>): void {
    const startTime = process.hrtime();
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;
    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: getRootWorkspacePath(),
      env: { SFDX_JSON_TO_STDOUT: 'true' }
    }).execute(cancellationToken);

    channelService.streamCommandStartStop(execution);

    let stdOut = '';
    execution.stdoutSubject.subscribe(realData => {
      stdOut += realData.toString();
    });

    execution.processExitSubject.subscribe(async exitCode => {
      this.logMetric(execution.command.logName, startTime);
      try {
        const createParser = new OrgCreateResultParser(stdOut);

        if (createParser.createIsSuccessful()) {
          // NOTE: there is a beta in which this command also allows users to create sandboxes
          // once it's GA this will have to be updated
          setWorkspaceOrgTypeWithOrgType(OrgType.SourceTracked);
        } else {
          const errorResponse = createParser.getResult() as OrgCreateErrorResult;
          if (errorResponse) {
            channelService.appendLine(errorResponse.message);
            telemetryService.sendException(
              'force_org_clone',
              errorResponse.message
            );
          }
        }
      } catch (err) {
        channelService.appendLine(
          nls.localize('force_org_clone_result_parsing_error')
        );
        channelService.appendLine(err);
        telemetryService.sendException(
          'force_org_clone',
          `Error while parsing org create response ${err}`
        );
      }
    });

    notificationService.reportCommandExecutionStatus(
      execution,
      cancellationToken
    );
    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }
}

export class AliasGatherer implements ParametersGatherer<Alias> {
  public async gather(): Promise<CancelResponse | ContinueResponse<Alias>> {
    const defaultWaitTime = DEFAULT_WAIT_TIME_MINS;
    let defaultAlias = DEFAULT_ALIAS;
    if (hasRootWorkspace()) {
      const folderName = getRootWorkspace().name.replace(
        /\W/g /* Replace all non-alphanumeric characters */,
        ''
      );
      defaultAlias = isAlphaNumSpaceString(folderName)
        ? folderName
        : DEFAULT_ALIAS;
    }

    const cloneSourceInputOption = {
      prompt: nls.localize('parameter_gatherer_enter_source_org'),
      placeHolder: defaultAlias,
      validateInput: value => {
        return isAlphaNumSpaceString(value) || value === ''
          ? null
          : nls.localize('error_invalid_org_alias');
      }
    } as vscode.InputBoxOptions;
    const cloneSource = await vscode.window.showInputBox(cloneSourceInputOption);
    // Hitting enter with no clone source specified, we use the clone source from def file
    if (cloneSource === undefined) {
      return { type: 'CANCEL' };
    }

    const sandboxNameInputOption = {
      prompt: nls.localize('parameter_gatherer_enter_sandbox_name'),
      placeHolder: defaultAlias,
      validateInput: value => {
        return isAlphaNumSpaceString(value) || value === ''
          ? null
          : nls.localize('error_invalid_org_alias');
      }
    } as vscode.InputBoxOptions;
    const sandboxName = await vscode.window.showInputBox(sandboxNameInputOption);
    if (sandboxName === undefined) {
      return { type: 'CANCEL' };
    }

    const aliasInputOptions = {
      prompt: nls.localize('parameter_gatherer_enter_alias_name'),
      placeHolder: defaultAlias,
      validateInput: value => {
        return isAlphaNumSpaceString(value) || value === ''
          ? null
          : nls.localize('error_invalid_org_alias');
      }
    } as vscode.InputBoxOptions;
    const alias = await vscode.window.showInputBox(aliasInputOptions);
    // Hitting enter with no alias will use the value of `defaultAlias`
    if (alias === undefined) {
      return { type: 'CANCEL' };
    }
    const waitTimeInMinsInputOptions = {
      prompt: nls.localize(
        'parameter_gatherer_enter_sandbox_org_wait_time_mins'
      ),
      placeHolder: defaultWaitTime,
      validateInput: value => {
        return isIntegerInRange(value, [0, 120]) || value === ''
          ? null
          : nls.localize('error_invalid_wait_time_mins');
      }
    } as vscode.InputBoxOptions;
    const scratchOrgExpirationInDays = await vscode.window.showInputBox(
      waitTimeInMinsInputOptions
    );
    if (scratchOrgExpirationInDays === undefined) {
      return { type: 'CANCEL' };
    }
    return {
      type: 'CONTINUE',
      data: {
        alias: alias === '' ? defaultAlias : alias,
        waitTime:
          scratchOrgExpirationInDays === ''
            ? defaultWaitTime
            : scratchOrgExpirationInDays,
        sourceSandbox: cloneSource,
        sandboxName
      }
    };
  }
}
export interface Alias {
  alias: string;
  waitTime: string;
  sourceSandbox: string;
  sandboxName: string;
}

export type AliasAndFileSelection = Alias & FileSelection;

const preconditionChecker = new CompositePreconditionChecker(
  new SfdxWorkspaceChecker(),
  new DevUsernameChecker()
);
const parameterGatherer = new CompositeParametersGatherer(
  // new FileSelector(
  //   nls.localize('parameter_gatherer_enter_sandbox_org_def_files'),
  //   nls.localize('error_no_sandbox_def'),
  //   'config/**/*-sandbox-def.json'
  // ),
  new AliasGatherer()
);

export async function forceSandboxClone() {
  const commandlet = new SfdxCommandlet(
    preconditionChecker,
    parameterGatherer,
    new ForceSandboxCloneExecutor()
  );
  await commandlet.run();
}