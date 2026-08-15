package io.github.nickssoftwarefun.skywatch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Background severe-weather notifications.
 *
 * The web app owns the settings (which categories, watches vs warnings, the
 * saved ZIP locations) and pushes them here as one JSON blob over the
 * SkywatchShell bridge. This class stores that config, keeps a periodic
 * JobScheduler job alive while notifications are enabled, and on each run
 * polls api.weather.gov for every configured location, posting one system
 * notification per new watch/warning in an enabled category.
 *
 * Alerts already notified are remembered as "id|endsMillis" entries so a
 * 15-minute poll cadence doesn't re-notify the same warning four times an
 * hour; entries are pruned once the alert has been over for a while.
 */
final class Alerts {

    private static final String PREFS = "skywatch_notify";
    private static final String K_CONFIG = "config";
    private static final String K_SEEN = "seen";
    private static final String CHANNEL = "wx-alerts";
    private static final int JOB_PERIODIC = 100;
    private static final int JOB_FIRST_CHECK = 101;
    private static final long PERIOD_MS = 15 * 60 * 1000L;       // JobScheduler's floor
    private static final long SEEN_SLACK_MS = 6 * 60 * 60 * 1000L;

    /**
     * Category keyword table — the Java mirror of NOTIFY_CATS in the web
     * app's js/config.js (see the ordering rationale there). First keyword
     * hit wins; no hit falls through to "other". Keep the two in sync.
     */
    private static final String[][] CATS = {
        { "tornado",  "tornado" },
        { "tstorm",   "thunderstorm" },
        { "flood",    "flood", "hydrologic" },
        { "tropical", "hurricane", "tropical", "storm surge", "typhoon" },
        { "winter",   "winter", "blizzard", "ice", "snow", "freez",
                      "frost", "chill", "cold", "avalanche" },
        { "heat",     "heat" },
        { "wind",     "wind", "gale" },
        { "fire",     "fire", "red flag" },
        { "airfog",   "fog", "air quality", "smoke", "dust",
                      "air stagnation", "ashfall" },
    };

    private Alerts() { }

    static String category(String event) {
        String e = event.toLowerCase(Locale.ROOT);
        for (String[] cat : CATS) {
            for (int i = 1; i < cat.length; i++) {
                if (e.contains(cat[i])) return cat[0];
            }
        }
        return "other";
    }

    /** Store the config pushed from the web app and (re)schedule accordingly. */
    static void saveConfig(Context ctx, String json) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean wasEnabled = isEnabled(sp.getString(K_CONFIG, null));
        boolean enabled = isEnabled(json);
        sp.edit().putString(K_CONFIG, json).apply();

        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (!enabled) {
            js.cancel(JOB_PERIODIC);
            js.cancel(JOB_FIRST_CHECK);
            return;
        }
        ComponentName svc = new ComponentName(ctx, AlertCheckService.class);
        // schedule() with the same id replaces the old job, so re-pushing
        // config while enabled is harmless
        js.schedule(new JobInfo.Builder(JOB_PERIODIC, svc)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)                    // survives reboot
                .build());
        if (!wasEnabled) {
            // just switched on: run once right away so currently-active alerts
            // show up as immediate feedback instead of "sometime in 15 minutes"
            js.schedule(new JobInfo.Builder(JOB_FIRST_CHECK, svc)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setOverrideDeadline(10_000L)
                    .build());
        }
    }

    private static boolean isEnabled(String json) {
        if (json == null) return false;
        try { return new JSONObject(json).optBoolean("enabled", false); }
        catch (Exception e) { return false; }
    }

    /** One polling pass over every configured location. Runs on a worker thread. */
    static void runCheck(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = sp.getString(K_CONFIG, null);
        JSONObject cfg;
        try { cfg = new JSONObject(raw); } catch (Exception e) { return; }
        if (!cfg.optBoolean("enabled", false)) return;

        boolean wantWarnings = cfg.optBoolean("warnings", true);
        boolean wantWatches = cfg.optBoolean("watches", true);
        JSONObject cats = cfg.optJSONObject("cats");
        JSONArray locs = cfg.optJSONArray("locations");
        if (locs == null) return;

        long now = System.currentTimeMillis();
        Set<String> seen = pruneSeen(sp.getStringSet(K_SEEN, null), now);

        for (int i = 0; i < locs.length(); i++) {
            JSONObject loc = locs.optJSONObject(i);
            if (loc == null) continue;
            JSONArray feats;
            try {
                String url = "https://api.weather.gov/alerts/active?status=actual&point="
                        + loc.optDouble("lat") + "," + loc.optDouble("lon");
                feats = new JSONObject(httpGet(url)).optJSONArray("features");
            } catch (Exception e) {
                continue;      // this location this round — next run retries
            }
            if (feats == null) continue;

            for (int f = 0; f < feats.length(); f++) {
                JSONObject feat = feats.optJSONObject(f);
                if (feat == null) continue;
                JSONObject props = feat.optJSONObject("properties");
                if (props == null) continue;

                String event = props.optString("event", "");
                String lower = event.toLowerCase(Locale.ROOT);
                boolean warning = lower.endsWith("warning");
                boolean watch = lower.endsWith("watch");
                if (!(warning && wantWarnings) && !(watch && wantWatches)) continue;
                if (cats != null && !cats.optBoolean(category(event), true)) continue;

                String id = feat.optString("id", props.optString("id", ""));
                if (id.isEmpty() || hasSeen(seen, id)) continue;

                long ends = parseTime(props.optString("ends", ""),
                        parseTime(props.optString("expires", ""), now + SEEN_SLACK_MS));
                seen.add(id + "|" + ends);
                postNotification(ctx, id, event,
                        loc.optString("name", ""),
                        props.optString("headline", ""),
                        props.optString("areaDesc", ""));
            }
        }
        sp.edit().putStringSet(K_SEEN, seen).apply();
    }

    private static boolean hasSeen(Set<String> seen, String id) {
        String prefix = id + "|";
        for (String s : seen) {
            if (s.startsWith(prefix)) return true;
        }
        return false;
    }

    /** Copy (never mutate the set SharedPreferences hands back) and drop long-ended alerts. */
    private static Set<String> pruneSeen(Set<String> stored, long now) {
        Set<String> out = new HashSet<>();
        if (stored == null) return out;
        for (String s : stored) {
            int bar = s.lastIndexOf('|');
            long ends = now;
            if (bar >= 0) {
                try { ends = Long.parseLong(s.substring(bar + 1)); }
                catch (NumberFormatException ignored) { }
            }
            if (ends + SEEN_SLACK_MS > now) out.add(s);
        }
        return out;
    }

    /** NWS timestamps look like 2026-08-15T12:00:00-05:00. */
    private static long parseTime(String iso, long fallback) {
        if (iso == null || iso.isEmpty()) return fallback;
        try {
            return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US)
                    .parse(iso).getTime();
        } catch (Exception e) {
            return fallback;
        }
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL,
                "Severe weather alerts", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Watches and warnings for your saved ZIP locations");
        nm.createNotificationChannel(ch);
    }

    private static void postNotification(Context ctx, String id, String event,
            String locName, String headline, String area) {
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, id.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String text = !headline.isEmpty() ? headline : area;
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(ctx, CHANNEL)
                : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH);
        Notification n = b.setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle(event + " — " + locName)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build();
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        // one notification per alert id: an update to the same alert replaces
        // rather than stacks
        nm.notify(id.hashCode(), n);
    }

    private static String httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(15_000);
        c.setRequestProperty("Accept", "application/geo+json");
        try (InputStream in = new BufferedInputStream(c.getInputStream())) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            c.disconnect();
        }
    }
}
