// OccasionVault Background Push Dispatcher v1
const admin = require("firebase-admin");

// Initialize Firebase Admin using Service Account from Environment Variables
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Error: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (e) {
  console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT:", e.message);
  process.exit(1);
}

const db = admin.firestore();
const messaging = admin.messaging();

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const CAT_LABELS = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  event: "Event",
  work: "Work",
  health: "Health",
  travel: "Travel",
  finance: "Finance",
  festival: "Festival",
  other: "Other"
};
function catLabel(cat) { return CAT_LABELS[cat] || cat; }

// Helper to get local time components for a given timezone
function getUserTime(timezone) {
  try {
    const options = {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      hour12: false,
      timeZone: timezone
    };
    const formatter = new Intl.DateTimeFormat("en-US", options);
    const parts = formatter.formatToParts(new Date());
    const dateObj = {};
    parts.forEach(p => dateObj[p.type] = p.value);
    
    return {
      year: parseInt(dateObj.year),
      month: parseInt(dateObj.month),
      day: parseInt(dateObj.day),
      hour: parseInt(dateObj.hour),
      minute: parseInt(dateObj.minute)
    };
  } catch (e) {
    // Fallback to UTC
    const d = new Date();
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes()
    };
  }
}

// Helper to calculate days until occasion
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
  const [h,m] = t.split(":").map(Number);
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`;
}

async function run() {
  console.log("🚀 Starting background occasion reminders scan...");
  
  const usersSnap = await db.collection("users").get();
  console.log(`Checking ${usersSnap.size} user account(s)...`);

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;

    // Get FCM token
    const tokenDoc = await db.collection("users").doc(uid).collection("meta").doc("fcmToken").get();
    if (!tokenDoc.exists) continue;
    const { token, timezone } = tokenDoc.data();
    if (!token) continue;

    // Get user occasions
    const occasionsSnap = await db.collection("users").doc(uid).collection("occasions").get();
    if (occasionsSnap.empty) continue;

    // Get time in user's timezone
    const userTime = getUserTime(timezone);
    
    // Get currently fired notifications map from Firestore
    const firedRef = db.collection("users").doc(uid).collection("meta").doc("firedNotifications");
    const firedDoc = await firedRef.get();
    let fired = {};
    if (firedDoc.exists) {
      fired = firedDoc.data();
    }

    const todayStr = `${userTime.year}-${userTime.month}-${userTime.day}`;

    for (const oDoc of occasionsSnap.docs) {
      const o = oDoc.data();
      const remindTime = o.remindTime || "09:00";
      const [rh, rm] = remindTime.split(":").map(Number);

      // Check if it is the current hour of the reminder (GitHub action runs hourly)
      if (userTime.hour !== rh) {
        continue;
      }

      const days = getDaysUntil(o.month, o.day, o.recurring, o.fullDate, o.recurrenceMode, userTime);
      if (days === null) continue;
      
      const remindDays = parseInt(o.remind || 7);
      let title = "";
      let body = "";
      let tag = "";

      if (days === 0) {
        tag = `ov-today-${oDoc.id}`;
        title = `${o.emoji} Today: ${o.name}! 🎉`;
        body = o.note || `${catLabel(o.cat)} — Don't forget!`;
      } else if (days === remindDays) {
        tag = `ov-remind-${oDoc.id}`;
        title = `${o.emoji} ${o.name} in ${days} day${days===1?"":"s"}!`;
        body = `${catLabel(o.cat)} · ${MONTHS_SHORT[o.month-1]} ${o.day} · Set for ${formatTime(o.remindTime)}`;
      } else {
        continue;
      }

      // Check if already fired today in the user's local timezone
      if (fired[tag] === todayStr) {
        continue;
      }

      // Send Push Notification
      try {
        console.log(`Sending notification to ${uid} for "${o.name}" (tag: ${tag})...`);
        await messaging.send({
          token: token,
          notification: {
            title: title,
            body: body
          },
          data: {
            tag: tag,
            url: "./"
          }
        });
        
        // Log fired state in Firestore
        fired[tag] = todayStr;
        console.log(`✅ Push sent successfully for "${o.name}"!`);
      } catch (err) {
        console.warn(`⚠️ Failed to send push to user ${uid} for "${o.name}":`, err.message);
      }
    }

    // Clean up fired history older than today and update Firestore
    let updatedFired = {};
    for (const key in fired) {
      if (fired[key] === todayStr) {
        updatedFired[key] = todayStr;
      }
    }
    await firedRef.set(updatedFired);
  }
  
  console.log("🏁 Background occasion scan completed.");
}

run().then(() => process.exit(0)).catch(err => {
  console.error("❌ Critical scan failure:", err);
  process.exit(1);
});
