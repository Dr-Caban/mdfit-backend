// A transfer that has stopped moving must be given up on quickly; a transfer that is merely slow must not be. So the
// clock here resets on every byte: a 430 MB file that keeps trickling is left alone, while a socket that goes quiet is
// abandoned in `idleMs`. There is still an absolute ceiling as a backstop.
//
// This exists because Google Drive throttles sustained bulk downloads - part way through mirroring a ~14 GB library it
// simply stops sending, with the socket open and no error. A fixed 15-minute cap did rescue the run, but burned 15
// minutes each time, and Drive stalled roughly every 35-50 files.
"use strict";
const { Transform } = require("stream");

function idleAbort(idleMs, ceilingMs) {
  const ctrl = new AbortController();
  let timer = null, hard = null, done = false;
  const clear = () => { clearTimeout(timer); clearTimeout(hard); timer = hard = null; };
  const fire = (why) => {
    if (done) return;
    done = true; clear();
    try { ctrl.abort(new Error(why)); } catch { ctrl.abort(); } // older runtimes take no abort reason
  };
  const bump = () => {
    if (done || !idleMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => fire(`stalled: no data for ${Math.round(idleMs / 1000)}s`), idleMs);
    if (timer.unref) timer.unref(); // never hold the process open on our account
  };
  bump();
  if (ceilingMs) { hard = setTimeout(() => fire(`gave up after ${Math.round(ceilingMs / 60000)} min`), ceilingMs); if (hard.unref) hard.unref(); }
  return { signal: ctrl.signal, bump, stop: () => { done = true; clear(); } };
}

// Count bytes WITHOUT changing how the stream behaves. Attaching a "data" listener would switch the source into
// flowing mode and race whatever reads it next, losing bytes; a Transform is pulled by its consumer, so backpressure
// and ordering are untouched and the watchdog still sees every chunk.
function meter(src, w) {
  return src.pipe(new Transform({ transform(chunk, _enc, cb) { w.bump(); cb(null, chunk); } }));
}

module.exports = { idleAbort, meter };
