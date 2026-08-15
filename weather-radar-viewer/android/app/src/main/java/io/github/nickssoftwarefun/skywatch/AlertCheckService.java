package io.github.nickssoftwarefun.skywatch;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** JobScheduler entry point: hands the periodic alert check to a worker thread. */
public class AlertCheckService extends JobService {

    private Thread worker;

    @Override
    public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            try {
                Alerts.runCheck(this);
            } finally {
                jobFinished(params, false);
            }
        }, "skywatch-alert-check");
        worker.start();
        return true;       // still working on a background thread
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (worker != null) worker.interrupt();
        return true;       // reschedule — the run was cut short
    }
}
