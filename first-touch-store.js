"use strict";

function selectFirstTouchCandidates(db, startAt, dueAt, limit = 20) {
  return db.prepare(`SELECT * FROM leads
    WHERE submitted_at>=?
      AND first_touch_sent_at IS NULL
      AND replied_at IS NULL
      AND duplicate_suppressed_at IS NULL
      AND first_touch_due_at<=?
    ORDER BY first_touch_due_at ASC
    LIMIT ?`).all(startAt, dueAt, limit);
}

module.exports = { selectFirstTouchCandidates };
