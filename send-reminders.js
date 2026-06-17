// OccasionVault Background Push Dispatcher v2
const admin = require("firebase-admin");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Error: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
  console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT:", e.message);
  process.exit(1);
}

const db        = admin.firestore();
const messaging = admin.messaging();

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CAT_LABELS   = {
  birthday:"Birthday", anniversary:"Anniversary", event:"Event",
  work:"Work", health:"Health", travel:"Travel",
  finance:"Finance", festival:"Festival", other:"Other"
};
function catLabel(cat) { return CAT_LABELS[cat] || cat; }

// Returns current time components in a given IANA timezone
function getUserTime(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      year:"numeric", month:"numeric", day:"numeric",
      hour:"numeric", minute:"numeric", second:"numeric",
      hour12:false, timeZone: timezone
    }).formatToParts(new Date());
    const d = {};
    parts.forEach(p => d[p.type] = p.value);
    return {
      year:   parseInt(d.year),
      month:  parseInt(d.month),
      day:    parseInt(d.day),
      hour:   parseInt(d.hour) % 24,   // guard against "24" midnight edge
      minute: parseInt(d.minute)
    };
  } catch {
    const n = new Date();
    return { year:n.getUTCFullYear(), month:n.getUTCMonth()+1, day:n.getUTCDate(),
             hour:n.getUTCHours(), minute:n.getUTCMinutes() };
  }
}

// Total minutes from midnight for easy comparison
function toMinutes(h, m) { return h * 60 + m; }

// True if the action is running within ±9 min of the scheduled reminder time
// (10-min cron window, ±9 keeps it tight but safe)
function isTimeMatch(userTime, remindTime) {
  const [rh, rm] = remindTime.split(":").map(Number);
  const target  = toMinutes(rh, rm);
  const current = toMinutes(userTime.hour, userTime.minute);
  // Handle midnight wrap-around
  const diff = Math.abs(current - target);
  return diff <= 9 || diff >= (24 * 60 - 9);
}

function getDaysUntil(month, day, recurring, fullDate, recurrenceMode, userTime) {
  const today = new Date(userTime.year, userTime.month - 1, userTime.day, 0, 0, 0, 0);
  if (!recurring && fullDate) {
    const d = new Date(fullDate); d.setHours(0,0,0,0);
    const diff = Math.ceil((d - today) / 86400000);
    return diff < 0 ? null : diff;
  }
  if (recurrenceMode === "monthly") {
    let next = new Date(today.getFullYear(), today.getMonth(), day);
    if (next < today) next = new Date(today.getFullYear(), today.getMonth()+1, day);
    return Math.ceil((next - today) / 86400000);
  }
  let next = new Date(today.getFullYear(), month-1, day);
  if (next < today) next = new Date(today.getFullYear()+1, month-1, day);
  return Math.ceil((next - today) / 86400000);
}

function formatTime(t) {
  if (!t) return "9:00 AM";
  const [h, m] = t.split(":").map(Number);
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`;
}

async function run() {
  console.log("🚀 OccasionVault reminder scan started at", new Date().toISOString());

  const usersSnap = await db.collection("users").get();
  console.log(`👥 ${usersSnap.size} user(s) found`);

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;

    // Get FCM token + timezone
    const tokenDoc = await db.collection("users").doc(uid).collection("meta").doc("fcmToken").get();
    if (!tokenDoc.exists) { console.log(`  [${uid}] No FCM token — skipping`); continue; }
    const { token, timezone } = tokenDoc.data();
    if (!token) { console.log(`  [${uid}] Empty FCM token — skipping`); continue; }

    // Get occasions
    const occasionsSnap = await db.collection("users").doc(uid).collection("occasions").get();
    if (occasionsSnap.empty) { console.log(`  [${uid}] No occasions — skipping`); continue; }

    const userTime = getUserTime(timezone || "Asia/Kolkata");
    console.log(`  [${uid}] timezone=${timezone} localTime=${userTime.hour}:${String(userTime.minute).padStart(2,"0")}`);

    // Fired-today dedup map
    const firedRef = db.collection("users").doc(uid).collection("meta").doc("firedNotifications");
    const firedDoc = await firedRef.get();
    let fired = firedDoc.exists ? firedDoc.data() : {};
    const todayStr = `${userTime.year}-${userTime.month}-${userTime.day}`;

    for (const oDoc of occasionsSnap.docs) {
      const o       = oDoc.data();
      const remindTime = o.remindTime || "09:00";

      // ── KEY FIX: match within ±9 min window instead of exact hour only ──
      if (!isTimeMatch(userTime, remindTime)) {
        continue;
      }

      const days      = getDaysUntil(o.month, o.day, o.recurring, o.fullDate, o.recurrenceMode, userTime);
      if (days === null) continue;

      const remindDays = parseInt(o.remind || 7);
      let title, body, tag;

      if (days === 0) {
        tag   = `ov-today-${oDoc.id}`;
        title = `${o.emoji} Today: ${o.name}! 🎉`;
        body  = o.note || `${catLabel(o.cat)} — Don't forget!`;
      } else if (days === remindDays) {
        tag   = `ov-remind-${oDoc.id}`;
        title = `${o.emoji} ${o.name} in ${days} day${days===1?"":"s"}!`;
        body  = `${catLabel(o.cat)} · ${MONTHS_SHORT[o.month-1]} ${o.day} · Reminder at ${formatTime(remindTime)}`;
      } else {
        continue;
      }

      // Dedup: don't send same notification twice in the same day
      if (fired[tag] === todayStr) {
        console.log(`  [${uid}] Already sent "${tag}" today — skipping`);
        continue;
      }

      try {
        console.log(`  [${uid}] Sending push: "${title}"`);
        await messaging.send({
          token,
          notification: { title, body },
          android: {
            priority: "high",
            notification: {
              sound:       "default",
              channelId:   "occasion-reminders",
              clickAction: "FLUTTER_NOTIFICATION_CLICK"
            }
          },
          webpush: {
            headers: { Urgency: "high" },
            notification: {
              title, body,
              icon:  "./icons/icon-192x192.png",
              badge: "./icons/icon-96x96.png",
              vibrate: [200, 100, 200],
              tag,
              renotify: true
            },
            fcmOptions: { link: "https://parthodas27806.github.io/OccasionVault/" }
          },
          data: { tag, url: "https://parthodas27806.github.io/OccasionVault/" }
        });
        fired[tag] = todayStr;
        console.log(`  ✅ Push sent for "${o.name}"`);
      } catch (err) {
        console.warn(`  ⚠️ Push failed for "${o.name}": ${err.message}`);
        // If token is stale/invalid, remove it so we don't keep trying
        if (err.code === "messaging/registration-token-not-registered" ||
            err.code === "messaging/invalid-registration-token") {
          await db.collection("users").doc(uid).collection("meta").doc("fcmToken").delete();
          console.warn(`  🗑️ Stale FCM token removed for user ${uid}`);
        }
      }
    }

    // Save updated fired map (only keep today's entries)
    const cleanFired = {};
    for (const k in fired) { if (fired[k] === todayStr) cleanFired[k] = todayStr; }
    await firedRef.set(cleanFired);
  }

  console.log("🏁 Scan complete at", new Date().toISOString());
}

run().then(() => process.exit(0)).catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
