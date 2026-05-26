/**
 * SCHEDULING ENGINE v5
 *
 * New features:
 *   1. Max_Shifts_Week — soft preference from Availability sheet.
 *      Engine respects it when possible, overrides only if no other way to fill shifts.
 *   2. Staff numbering — Staff #1 = fresher employee, Staff #2 = worked evening before.
 *   3. Bookings input — parallel "Event" type bookings add extra staff to that shift.
 */

const employeeRows  = $('Get Employees').all().map(i => i.json);
const availRows     = $('Get Availability').all().map(i => i.json);
const hoursRows     = $('Get Hours Log').all().map(i => i.json);
const shiftPrioRows = $('Get Shift Priority').all().map(i => i.json);

// NEW: Bookings input (optional — if node exists)
let bookingRows = [];
try { bookingRows = $('Get Bookings').all().map(i => i.json); } catch(e) { /* no bookings node */ }

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalizeDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  if (s.includes('-') && (s.includes(' ') || s.includes('T'))) return s.substring(0, 10);
  const num = parseFloat(s);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30 + Math.round(num)));
    return d.toISOString().substring(0, 10);
  }
  return s;
}

function toMinutes(val) {
  if (val === null || val === undefined || val === '' || String(val).toLowerCase() === 'last game') return null;
  if (typeof val === 'number' && val >= 0 && val < 1.5) return Math.round(val * 1440);
  const s = String(val).trim();
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
  }
  if (typeof val === 'number' && val >= 60) return val;
  return null;
}

function fromMinutes(mins) {
  if (mins == null) return '??:??';
  return `${String(Math.floor(mins / 60) % 24).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
}

function parseToDate(val) {
  const s = normalizeDate(val);
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isTruthy(val) {
  if (typeof val === 'boolean') return val;
  return String(val).toUpperCase() === 'TRUE';
}

function normLoc(val) {
  if (!val) return '';
  const s = String(val).trim().toLowerCase();
  if (s === 'all' || s === 'both') return 'All';
  const n = parseFloat(s);
  if (!isNaN(n) && n === Math.floor(n)) return String(Math.floor(n));
  return String(val).trim();
}

// Get previous day date string
function prevDay(dateStr) {
  const d = parseToDate(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────
// 1. EMPLOYEES
// ─────────────────────────────────────────────

const employees = employeeRows
  .filter(e => isTruthy(e.Active))
  .map(e => {
    const roomSkills = { '1': [], '2': [] };
    ['1','2','3','4'].forEach(r => {
      if (isTruthy(e[`L1_Room${r}`])) roomSkills['1'].push(r);
      if (isTruthy(e[`L2_Room${r}`])) roomSkills['2'].push(r);
    });
    const log = hoursRows.find(h => h.Employee === e.Name) || {};

    return {
      name:          e.Name,
      phone:         e.Phone,
      location:      normLoc(e.Location),
      roomSkills,
      canRunVikings: isTruthy(e.Vikings),
      isSalesRole:   isTruthy(e.Sales_Role),
      hoursMTD:      parseFloat(log.Hours_This_Month || log.Actual_Hours || 0),
      lastShiftDate: parseToDate(log.Last_Shift_Date) || new Date(2000, 0, 1),
      lateNightFlag: isTruthy(log.Late_Night_Flag),
      assignedShifts: [],   // shift IDs assigned this week
      shiftsThisWeek: 0,    // counter for max_shifts preference
    };
  });

// ─────────────────────────────────────────────
// 2. AVAILABILITY MAP + Max_Shifts_Week
// ─────────────────────────────────────────────

const availMap = {};
const maxShiftsPreference = {}; // empName → number or null

availRows.forEach(row => {
  if (isTruthy(row.Not_Available)) return;
  const empName  = row.Employee_Name;
  const dateKey  = normalizeDate(row.Date);
  const fromMins = toMinutes(row.From);
  const toMins_v = toMinutes(row.To);
  if (!dateKey || fromMins === null || toMins_v === null) return;

  if (!availMap[empName]) availMap[empName] = {};
  availMap[empName][dateKey] = {
    fromMins,
    toMins: toMins_v,
    totalHours: (toMins_v - fromMins) / 60,
    canRun: row.Can_Run_Games || '',
  };

  // Read Max_Shifts_Week (take from any row — same per employee per week)
  if (row.Max_Shifts_Week !== undefined && row.Max_Shifts_Week !== null && row.Max_Shifts_Week !== '') {
    const val = parseInt(row.Max_Shifts_Week);
    if (!isNaN(val) && val > 0) {
      maxShiftsPreference[empName] = val;
    }
  }
});

// ─────────────────────────────────────────────
// 3. PROCESS BOOKINGS — detect parallel Events
// ─────────────────────────────────────────────

// Group bookings by date+location+time to find parallel events
// If 2+ "Event" bookings overlap → need +1 staff for that shift
const extraStaffFromBookings = {}; // key: "date|shift|location" → extra staff count

bookingRows.forEach(booking => {
  // Handle both lowercase (from WordPress/API) and uppercase (from Google Sheets) field names
  const dateKey = normalizeDate(booking.date || booking.Date);
  const type = String(booking.type || booking.Type || booking.Booking_Type || '').toLowerCase();
  const loc = normLoc(booking.location || booking.Location);
  const timeMins = toMinutes(booking.time || booking.Time || booking.Start_Time || booking.start_time);
  if (!dateKey || !timeMins) return;

  // Determine which shift this booking falls in
  const shiftName = timeMins < 1020 ? 'Morning' : 'Evening'; // before/after 17:00

  const key = `${dateKey}|${shiftName}|${loc}`;
  if (!extraStaffFromBookings[key]) {
    extraStaffFromBookings[key] = { events: [], totalExtra: 0 };
  }

  if (type === 'event') {
    extraStaffFromBookings[key].events.push({
      time: timeMins,
      name: booking.room || booking.Room || booking.Name || 'Event',
    });
  }
});

// Calculate extra staff: for N parallel events, need N-1 extra staff
// (1 event = covered by base staff, 2+ parallel = need more)
Object.entries(extraStaffFromBookings).forEach(([key, data]) => {
  if (data.events.length >= 2) {
    // Group events that overlap (within 60 min of each other = parallel)
    const sorted = data.events.sort((a, b) => a.time - b.time);
    let maxParallel = 1;
    for (let i = 0; i < sorted.length; i++) {
      let parallel = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].time - sorted[i].time <= 60) parallel++;
      }
      maxParallel = Math.max(maxParallel, parallel);
    }
    // 2 parallel events → 1 extra staff, 3 parallel → 2 extra, etc.
    data.totalExtra = maxParallel - 1;
  }
});

// ─────────────────────────────────────────────
// 4. BUILD SHIFT SLOTS
// ─────────────────────────────────────────────

const SHIFT_RULES = {
  Sunday:    { Morning: { staff: 1 }, Evening: { staff: 1 } },
  Monday:    { Morning: { staff: 1 }, Evening: { staff: 1 } },
  Tuesday:   { Morning: { staff: 1 }, Evening: { staff: 2, lastGame: true } },
  Wednesday: { Morning: { staff: 1 }, Evening: { staff: 1 } },
  Thursday:  { Morning: { staff: 1 }, Evening: { staff: 1 } },
  Friday:    { Morning: { staff: 2 }, Evening: { staff: 1, lastGame: true } },
  Saturday:  { Morning: { staff: 3 }, Evening: { staff: 2, lastGame: true } },
};

const LOCATIONS = ['1', '2'];
const allShifts = [];

shiftPrioRows.forEach((row, idx) => {
  const rule     = (SHIFT_RULES[row.Day] || {})[row.Shift] || {};
  const dateKey  = normalizeDate(row.Date);
  const fromMins = toMinutes(row.Shift_From) || (row.Shift === 'Morning' ? 570 : 1020);
  const isLast   = String(row.Shift_To).toLowerCase() === 'last game';
  const toMins   = isLast ? null : toMinutes(row.Shift_To);

  LOCATIONS.forEach(loc => {
    // Check if bookings require extra staff
    const bookingKey = `${dateKey}|${row.Shift}|${loc}`;
    const extra = (extraStaffFromBookings[bookingKey] || {}).totalExtra || 0;
    const baseStaff = parseInt(row.Staff_Needed) || rule.staff || 1;

    allShifts.push({
      id:           `${idx}_L${loc}`,
      day:          row.Day,
      date:         dateKey,
      dateObj:      parseToDate(row.Date),
      shift:        row.Shift,
      fromMins, toMins,
      staffNeeded:  baseStaff + extra,
      extraFromBookings: extra,
      fixedEmployee: row.Manager_Fixed || null,
      isLastGame:   !!rule.lastGame || isLast,
      location:     loc,
      assigned:     [],
      flag:         extra > 0 ? `ℹ️ +${extra} staff for ${extra + 1} parallel events` : '',
      pressure:     999,
      candidateList: [],
    });
  });
});

// ─────────────────────────────────────────────
// 5. HELPER FUNCTIONS
// ─────────────────────────────────────────────

function isAvailable(emp, shift) {
  const a = (availMap[emp.name] || {})[shift.date];
  if (!a) return false;
  if (a.fromMins === null || a.toMins === null) return false;
  return a.fromMins <= shift.fromMins && a.toMins >= (shift.fromMins + 180);
}

function hasLocationSkill(emp, shift) {
  return emp.location === 'All' || emp.location === shift.location;
}

function isRestBlocked(emp, shift) {
  if (!emp.lateNightFlag || shift.shift !== 'Morning') return false;
  if (!emp.lastShiftDate || !shift.dateObj) return false;
  return (shift.dateObj - emp.lastShiftDate) / 86400000 <= 1;
}

function isAlreadyAssignedToday(emp, shift, assignments) {
  return assignments.some(a =>
    a.employeeName === emp.name && a.date === shift.date
  );
}

// FEATURE 1: Check if employee has reached their preferred max shifts
function isOverPreferredMax(emp) {
  const pref = maxShiftsPreference[emp.name];
  if (!pref) return false; // no preference = no limit
  return emp.shiftsThisWeek >= pref;
}

// Score candidate — now includes max_shifts preference penalty
function scoreCandidate(emp, shift) {
  const rooms = (emp.roomSkills[shift.location] || []).length * 1000;
  const a = (availMap[emp.name] || {})[shift.date];
  const availHrs = a ? (a.toMins - a.fromMins) / 60 : 0;
  const mtdBonus = Math.max(0, 500 - emp.hoursMTD) * 10;
  const lastDays = emp.lastShiftDate ? (Date.now() - emp.lastShiftDate.getTime()) / 86400000 : 0;

  // Penalty if employee is over their preferred max (but still eligible)
  const overPrefPenalty = isOverPreferredMax(emp) ? -5000 : 0;

  return rooms + availHrs * 100 + mtdBonus + lastDays + overPrefPenalty;
}

function assessImpact(emp, shift) {
  let risk = 0;
  for (const fs of allShifts) {
    if (fs.id === shift.id || fs.assigned.length >= fs.staffNeeded) continue;
    const stillNeeded = fs.staffNeeded - fs.assigned.length;
    if (fs.candidateList.length < stillNeeded) continue;
    const without = fs.candidateList.filter(c => c.name !== emp.name);
    if (without.length < stillNeeded) risk++;
  }
  return { isSafe: risk === 0, risk };
}

// FEATURE 2: Did this employee work evening shift the day before?
function workedEveningBefore(emp, dateStr, assignments) {
  const prev = prevDay(dateStr);
  if (!prev) return false;
  return assignments.some(a =>
    a.employeeName === emp.name && a.date === prev && a.shift === 'Evening'
  );
}

// ─────────────────────────────────────────────
// 6. BUILD CANDIDATE LISTS
// ─────────────────────────────────────────────

allShifts.forEach(shift => {
  shift.candidateList = employees.filter(emp => {
    return isAvailable(emp, shift) && hasLocationSkill(emp, shift) && !isRestBlocked(emp, shift);
  });
  shift.pressure = shift.candidateList.length - shift.staffNeeded;
});

allShifts.sort((a, b) => a.pressure - b.pressure);

// ─────────────────────────────────────────────
// 7. ASSIGN
// ─────────────────────────────────────────────

const finalAssignments = [];

for (const shift of allShifts) {

  // Fixed employee from sheet
  if (shift.fixedEmployee) {
    const fixed = employees.find(e => e.name === shift.fixedEmployee);
    if (fixed && isAvailable(fixed, shift) && !isAlreadyAssignedToday(fixed, shift, finalAssignments)) {
      shift.assigned.push(fixed.name);
      fixed.shiftsThisWeek++;
      finalAssignments.push({
        day: shift.day, date: shift.date, shift: shift.shift,
        location: shift.location, employeeName: fixed.name,
        role: 'Staff #1',
        from: fromMinutes(shift.fromMins),
        to: shift.isLastGame ? 'Last game' : fromMinutes(shift.toMins),
        estHours: shift.isLastGame ? '~6' : ((shift.toMins - shift.fromMins) / 60).toFixed(1),
        flag: '✅ Fixed assignment', status: 'Draft',
      });
    }
  }

  let stillNeeded = shift.staffNeeded - shift.assigned.length;
  if (stillNeeded <= 0) continue;

  // Filter available candidates
  const available = shift.candidateList.filter(emp =>
    !shift.assigned.includes(emp.name) &&
    !isAlreadyAssignedToday(emp, shift, finalAssignments)
  );

  // Sort: prefer employees NOT over their max_shifts preference
  // Among those, sort by score
  const ranked = available
    .map(emp => ({ emp, score: scoreCandidate(emp, shift), overPref: isOverPreferredMax(emp) }))
    .sort((a, b) => {
      // First: not-over-pref before over-pref
      if (a.overPref !== b.overPref) return a.overPref ? 1 : -1;
      // Then by score
      return b.score - a.score;
    });

  for (const { emp } of ranked) {
    if (stillNeeded <= 0) break;
    const impact = assessImpact(emp, shift);

    if (impact.isSafe || ranked.length <= stillNeeded) {
      shift.assigned.push(emp.name);
      emp.shiftsThisWeek++;

      const a = (availMap[emp.name] || {})[shift.date];
      const shiftTo = shift.toMins || (shift.fromMins + 360);
      const empTo = a ? Math.min(a.toMins, shiftTo) : shiftTo;
      const est = Math.max((empTo - shift.fromMins) / 60, 3).toFixed(1);

      // FEATURE 2: role number — worked evening before = higher number
      // Will be recalculated after all assignments (see step 8)
      finalAssignments.push({
        day: shift.day, date: shift.date, shift: shift.shift,
        location: shift.location, employeeName: emp.name,
        role: 'Staff', // placeholder — numbered in step 8
        from: fromMinutes(shift.fromMins),
        to: shift.isLastGame ? 'Last game' : fromMinutes(empTo),
        estHours: est, eventPrep: 'No',
        flag: (impact.isSafe ? '' : '⚠️ Risk accepted — limited options') +
              (isOverPreferredMax(emp) ? ` ℹ️ Over preferred max (${maxShiftsPreference[emp.name]} shifts)` : ''),
        status: 'Draft',
      });
      emp.assignedShifts.push(shift.id);
      stillNeeded--;
    }
  }

  // Unfilled
  if (stillNeeded > 0) {
    const flagMsg = `⚠️ Missing ${stillNeeded} staff — no available qualified employee`;
    for (let i = 0; i < stillNeeded; i++) {
      finalAssignments.push({
        day: shift.day, date: shift.date, shift: shift.shift,
        location: shift.location, employeeName: 'TBD',
        role: `Staff #${shift.assigned.length + i + 1}`,
        from: fromMinutes(shift.fromMins),
        to: shift.isLastGame ? 'Last game' : fromMinutes(shift.toMins),
        estHours: '?', eventPrep: 'No',
        flag: flagMsg + (shift.extraFromBookings > 0 ? ` ${shift.flag}` : ''),
        status: 'Draft',
      });
    }
  }
}

// ─────────────────────────────────────────────
// 8. ASSIGN STAFF NUMBERS
// ─────────────────────────────────────────────
// For shifts with 2+ staff: Staff #1 = didn't work evening before, Staff #2 = did work evening before
// Higher number = worked evening shift the day before

// Group assignments by shift
const shiftGroups = {};
finalAssignments.forEach((a, idx) => {
  if (a.employeeName === 'TBD') return;
  const key = `${a.date}|${a.shift}|${a.location}`;
  if (!shiftGroups[key]) shiftGroups[key] = [];
  shiftGroups[key].push({ idx, name: a.employeeName });
});

Object.entries(shiftGroups).forEach(([key, members]) => {
  if (members.length <= 1) {
    // Single staff — just Staff #1
    if (members[0]) finalAssignments[members[0].idx].role = 'Staff #1';
    return;
  }

  // Sort: employees who worked evening before get higher numbers
  const dateStr = key.split('|')[0];
  members.sort((a, b) => {
    const aWorkedEvening = workedEveningBefore({ name: a.name }, dateStr, finalAssignments) ? 1 : 0;
    const bWorkedEvening = workedEveningBefore({ name: b.name }, dateStr, finalAssignments) ? 1 : 0;
    return aWorkedEvening - bWorkedEvening; // 0 first (didn't work evening) = lower number
  });

  members.forEach((m, i) => {
    finalAssignments[m.idx].role = `Staff #${i + 1}`;
  });
});

// ─────────────────────────────────────────────
// 9. WINDOW GAP CHECK
// ─────────────────────────────────────────────

finalAssignments.forEach(a => {
  if (a.estHours !== '?' && parseFloat(a.estHours) > 5) {
    a.windowCheck = 'ℹ️ Long shift — check for gaps >2.5hrs';
  }
});

// ─────────────────────────────────────────────
// 10. SUMMARY
// ─────────────────────────────────────────────

const byDay = {};
finalAssignments.forEach(a => {
  const key = `${a.day} ${a.date}`;
  if (!byDay[key]) byDay[key] = [];
  byDay[key].push(a);
});

let summaryText = `📅 DRAFT SCHEDULE — Week Starting ${normalizeDate(shiftPrioRows[0]?.Week_Start) || ''}\n`;
summaryText += `Generated: ${new Date().toISOString()}\n\n`;

Object.entries(byDay).forEach(([dayKey, entries]) => {
  summaryText += `━━━ ${dayKey} ━━━\n`;
  entries.forEach(e => {
    const flag = e.flag ? ` ${e.flag}` : '';
    summaryText += `  [L${e.location}] ${e.shift}: ${e.employeeName} (${e.role}, ${e.from}–${e.to}, ~${e.estHours}h)${flag}\n`;
  });
  summaryText += '\n';
});

// Max shifts summary
const prefSummary = Object.entries(maxShiftsPreference).map(([name, pref]) => {
  const emp = employees.find(e => e.name === name);
  const actual = emp ? emp.shiftsThisWeek : 0;
  const status = actual <= pref ? '✅' : '⚠️ Over preferred';
  return `  ${name}: wanted ${pref}, got ${actual} ${status}`;
}).join('\n');

if (prefSummary) {
  summaryText += `\n📊 SHIFT PREFERENCES:\n${prefSummary}\n`;
}

const warnings = finalAssignments.filter(a => a.flag && a.flag.includes('⚠️'));
if (warnings.length > 0) {
  summaryText += `\n⚠️ WARNINGS (${warnings.length}):\n`;
  warnings.forEach(w => {
    summaryText += `  • ${w.day} L${w.location} ${w.shift}: ${w.flag}\n`;
  });
}

return finalAssignments.map(row => ({
  json: {
    ...row,
    weekStart: normalizeDate(shiftPrioRows[0]?.Week_Start) || '',
    summary: summaryText,
  }
}));
