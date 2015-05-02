/*
 * Copyright © 2015 Cask Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

package co.cask.cdap.internal.app.services;

import co.cask.cdap.app.program.Program;
import co.cask.cdap.app.runtime.ProgramController;
import co.cask.cdap.app.runtime.ProgramRuntimeService;
import co.cask.cdap.app.runtime.ProgramRuntimeService.RuntimeInfo;
import co.cask.cdap.app.store.Store;
import co.cask.cdap.common.app.RunIds;
import co.cask.cdap.common.exception.ProgramNotFoundException;
import co.cask.cdap.internal.app.runtime.AbstractListener;
import co.cask.cdap.internal.app.runtime.BasicArguments;
import co.cask.cdap.internal.app.runtime.ProgramOptionConstants;
import co.cask.cdap.internal.app.runtime.SimpleProgramOptions;
import co.cask.cdap.proto.Id;
import co.cask.cdap.proto.ProgramRunStatus;
import co.cask.cdap.proto.ProgramType;
import co.cask.cdap.proto.RunRecord;
import com.google.common.base.Predicate;
import com.google.common.util.concurrent.AbstractIdleService;
import com.google.inject.Inject;
import org.apache.twill.api.RunId;
import org.apache.twill.common.Threads;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.annotation.Nullable;

/**
 * Service that manages lifecycle of Programs.
 */
public class ProgramLifecycleService extends AbstractIdleService {
  private static final Logger LOG = LoggerFactory.getLogger(ProgramLifecycleService.class);

  private final ScheduledExecutorService scheduledExecutorService;
  private final Store store;
  private final ProgramRuntimeService runtimeService;

  @Inject
  public ProgramLifecycleService(Store store, ProgramRuntimeService runtimeService) {
    this.store = store;
    this.runtimeService = runtimeService;
    this.scheduledExecutorService = Executors.newScheduledThreadPool(1);
  }

  @Override
  protected void startUp() throws Exception {
    LOG.info("Starting ProgramLifecycleService");

    scheduledExecutorService.scheduleAtFixedRate(new RunRecordsCorrectorRunnable(this, store, runtimeService),
                                                 2L, 600L, TimeUnit.SECONDS);
  }

  @Override
  protected void shutDown() throws Exception {
    LOG.info("Shutting down ProgramLifecycleService");

    scheduledExecutorService.shutdown();
    try {
      if (!scheduledExecutorService.awaitTermination(5, TimeUnit.SECONDS)) {
        scheduledExecutorService.shutdownNow();
      }
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
    }
  }

  private Program getProgram(Id.Program id, ProgramType programType) throws IOException, ProgramNotFoundException {
    Program program = store.loadProgram(id, programType);
    if (program == null) {
      throw new ProgramNotFoundException(id);
    }
    return program;
  }

  /**
   * Start a Program.
   *
   * @param id {@link Id.Program}
   * @param programType {@link ProgramType}
   * @param systemArgs system arguments
   * @param userArgs user arguments
   * @param debug enable debug mode
   * @return {@link ProgramRuntimeService.RuntimeInfo}
   * @throws IOException if there is an error starting the program
   * @throws ProgramNotFoundException if program is not found
   */
  public ProgramRuntimeService.RuntimeInfo start(final Id.Program id, final ProgramType programType,
                                                 Map<String, String> systemArgs, Map<String, String> userArgs,
                                                 boolean debug)
    throws IOException, ProgramNotFoundException {
    final String adapterName = systemArgs.get(ProgramOptionConstants.ADAPTER_NAME);
    Program program = getProgram(id, programType);
    BasicArguments systemArguments = new BasicArguments(systemArgs);
    BasicArguments userArguments = new BasicArguments(userArgs);
    ProgramRuntimeService.RuntimeInfo runtimeInfo = runtimeService.run(program, new SimpleProgramOptions(
      id.getId(), systemArguments, userArguments, debug));

    final ProgramController controller = runtimeInfo.getController();
    final String runId = controller.getRunId().getId();
    final String twillRunId = runtimeInfo.getTwillRunId() == null ? null : runtimeInfo.getTwillRunId().getId();
    if (programType != ProgramType.MAPREDUCE) {
      // MapReduce state recording is done by the MapReduceProgramRunner
      // TODO [JIRA: CDAP-2013] Same needs to be done for other programs as well
      controller.addListener(new AbstractListener() {
        @Override
        public void init(ProgramController.State state, @Nullable Throwable cause) {
          // Get start time from RunId
          long startTimeInSeconds = RunIds.getTime(controller.getRunId(), TimeUnit.SECONDS);
          if (startTimeInSeconds == -1) {
            // If RunId is not time-based, use current time as start time
            startTimeInSeconds = TimeUnit.MILLISECONDS.toSeconds(System.currentTimeMillis());
          }
          store.setStart(id, runId, startTimeInSeconds, adapterName, twillRunId);
          if (state == ProgramController.State.COMPLETED) {
            completed();
          }
          if (state == ProgramController.State.ERROR) {
            error(controller.getFailureCause());
          }
        }

        @Override
        public void completed() {
          LOG.debug("Program {} {} {} completed successfully.", id.getNamespaceId(), id.getApplicationId(), id.getId());
          store.setStop(id, runId, TimeUnit.MILLISECONDS.toSeconds(System.currentTimeMillis()),
                        ProgramController.State.COMPLETED.getRunStatus());
        }

        @Override
        public void killed() {
          LOG.debug("Program {} {} {} killed.", id.getNamespaceId(), id.getApplicationId(), id.getId());
          store.setStop(id, runId, TimeUnit.MILLISECONDS.toSeconds(System.currentTimeMillis()),
                        ProgramController.State.KILLED.getRunStatus());
        }

        @Override
        public void suspended() {
          LOG.debug("Suspending Program {} {} {} {}.", id.getNamespaceId(), id.getApplicationId(), id, runId);
          store.setSuspend(id, runId);
        }

        @Override
        public void resuming() {
          LOG.debug("Resuming Program {} {} {} {}.", id.getNamespaceId(), id.getApplicationId(), id, runId);
          store.setResume(id, runId);
        }

        @Override
        public void error(Throwable cause) {
          LOG.info("Program stopped with error {}, {}", id, runId, cause);
          store.setStop(id, runId, TimeUnit.MILLISECONDS.toSeconds(System.currentTimeMillis()),
                        ProgramController.State.ERROR.getRunStatus());
        }
      }, Threads.SAME_THREAD_EXECUTOR);
    }
    return runtimeInfo;
  }

  /**
   * Stop a Program given its {@link RunId}.
   *
   * @param programId The id of the program
   * @param runId {@link RunId} of the program
   * @throws ExecutionException
   * @throws InterruptedException
   */
  //TODO: Improve this once we have logic moved from ProgramLifecycleHttpHandler for stopping a program
  public void stopProgram(Id.Program programId, RunId runId) throws ExecutionException, InterruptedException {
    ProgramRuntimeService.RuntimeInfo runtimeInfo = runtimeService.lookup(programId, runId);
    if (runtimeInfo != null) {
      runtimeInfo.getController().stop().get();
    }
  }

  /**
   * Returns runtime information for the given program if it is running,
   * or {@code null} if no instance of it is running.
   *
   * @param programId {@link Id.Program}
   * @param programType {@link ProgramType}
   */
  public ProgramRuntimeService.RuntimeInfo findRuntimeInfo(Id.Program programId, ProgramType programType) {
    Collection<ProgramRuntimeService.RuntimeInfo> runtimeInfos = runtimeService.list(programType).values();
    for (ProgramRuntimeService.RuntimeInfo info : runtimeInfos) {
      if (programId.equals(info.getProgramId())) {
        return info;
      }
    }
    return null;
  }

  /**
   * Fix all the possible inconsistent states for RunRecords that shows it is in RUNNING state but actually not
   * via check to {@link ProgramRuntimeService}.
   *
   * @param programType The type of programs the run records nee to validate and update.
   * @param store The data store that manages run records instances for all programs.
   * @param runtimeService The {@link ProgramRuntimeService} instance to check the actual state of the program.
   */
  private  void validateAndCorrectRunningRunRecords(ProgramType programType, Store store,
                                                  ProgramRuntimeService runtimeService) {
      final Map<RunId, RuntimeInfo> runIdToRuntimeInfo = runtimeService.list(programType);

    List<RunRecord> invalidRunRecords = store.getRuns(ProgramRunStatus.RUNNING, new Predicate<RunRecord>() {
      @Override
      public boolean apply(@Nullable RunRecord input) {
        if (input == null) {
          return false;
        }
        // Check if it is actually running
        String runId = input.getPid();
        return !runIdToRuntimeInfo.containsKey(RunIds.fromString(runId));
      }
    });

    if (!invalidRunRecords.isEmpty()) {
      LOG.debug("Found {} RunRecords with RUNNING status but the program not actually running.",
                invalidRunRecords.size());
    }

    // Now lets correct the invalid RunRecords
    for (RunRecord rr : invalidRunRecords) {
      String runId = rr.getPid();
      RuntimeInfo runtimeInfo = runIdToRuntimeInfo.get(RunIds.fromString(runId));
      store.compareAndSetStatus(runtimeInfo.getProgramId(), runId, ProgramController.State.ALIVE.getRunStatus(),
                                ProgramController.State.ERROR.getRunStatus());
    }
  }

  /**
   * Helper class to run in separate thread to validate t
   */
  public static class RunRecordsCorrectorRunnable implements Runnable {
    private final ProgramLifecycleService programLifecycleService;
    private final Store store;
    private final ProgramRuntimeService runtimeService;

    public RunRecordsCorrectorRunnable(ProgramLifecycleService programLifecycleService, Store store,
                                       ProgramRuntimeService runtimeService) {
      this.programLifecycleService = programLifecycleService;
      this.store = store;
      this.runtimeService = runtimeService;
    }

    @Override
    public void run() {
      // Lets update the running programs run records
      for (ProgramType programType : ProgramType.values()) {
        programLifecycleService.validateAndCorrectRunningRunRecords(programType, store, runtimeService);
      }
    }
  }

}
