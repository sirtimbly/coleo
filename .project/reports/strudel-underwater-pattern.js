// Paste into https://strudel.cc
// Progressive underwater harmony with procedural chord + melody generation.

setcpm(100 / 4);

var progression = [
  ["c3", "eb3", "g3", "bb3"],   // Cm7
  ["ab2", "c3", "eb3", "g3"],   // Abmaj7
  ["f2", "ab2", "c3", "eb3"],   // Fm7
  ["g2", "b2", "d3", "f3"],     // G7
  ["d2", "f2", "ab2", "c3"],    // Dm7b5
  ["g2", "b2", "d3", "f3"],     // G7
  ["c3", "eb3", "g3", "bb3"],   // Cm7
  ["eb3", "g3", "bb3", "d4"],   // Ebmaj7
];

var chordPadPattern = progression
  .map(function (chord) { return "[" + chord.join(" ") + "] ~"; })
  .join(" ");

var bassPattern = progression
  .map(function (chord) { return chord[0] + " ~"; })
  .join(" ");

var melodyPattern = progression
  .map(function (chord, index) {
    var t = chord[1];
    var f = chord[2];
    var s = chord[3];
    var lift = index % 2 === 0 ? "'" : "";
    return f + lift + " " + s + lift + " " + f + lift + " " + t + lift;
  })
  .join(" ");

stack(
  note(bassPattern)
    .sound("triangle")
    .slow(2)
    .gain(0.24)
    .lpf(260)
    .room(0.5)
    .size(0.7),

  note(chordPadPattern)
    .sound("sine")
    .slow(2)
    .gain(0.16)
    .lpf(980)
    .room(0.86)
    .size(0.9),

  note(melodyPattern)
    .sound("sawtooth")
    .slow(2)
    .gain(0.09)
    .lpf(1700)
    .delay(0.2)
    .room(0.74),

  s("hh*8")
    .mask("1 0 0 1 1 0 1 0")
    .gain(0.06)
    .hpf(5300),

  s("bd ~ ~ bd")
    .gain(0.14)
    .lpf(170)
);
