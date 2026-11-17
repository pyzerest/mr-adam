// A small swerve drivebase with electronics, used as the starting document so
// every feature (tubes, plates, mates, wiring) has something to show.
import { app, select } from './app.js';
import { emptyDoc, syncAll, addPart, rigidMate, commit } from './doc.js';
import { newTube, newPlate } from './parts/parts.js';
import { autowire } from './wiring/autowire.js';

const rotZ = (deg) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
const rotY = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

export function loadSample() {
  app.doc = { ...emptyDoc(), name: 'Sample swerve bot' };
  select([]);
  syncAll();
  const tube = (profile, length, pos, quat) => addPart({ ...newTube(profile, length), pos, quat }, { silent: true });
  const lib = (def, pos, quat) => addPart({ kind: 'lib', def, pos, quat }, { silent: true });
  const on = (child, parent) => { rigidMate(child.id, parent.id); return child; };

  // frame: 28" square of 2x1, tops at z = 3.25
  const front = tube('2x1', 28, [-14, -13.5, 2.25]);
  const back = on(tube('2x1', 28, [-14, 13.5, 2.25]), front);
  const left = on(tube('2x1', 26, [-13.5, -13, 2.25], rotZ(90)), front);
  const right = on(tube('2x1', 26, [13.5, -13, 2.25], rotZ(90)), front);

  // belly pan: plus-shaped polycarb so the wheels clear it
  const a = 14, b = 7.5;
  const pan = on(addPart(newPlate([{ t: 'poly', closed: true, pts: [[-b, -a], [b, -a], [b, -b], [a, -b], [a, b], [b, b], [b, a], [-b, a], [-b, b], [-a, b], [-a, -b], [-b, -b]] }],
    { thickness: 0.25, material: 'pc', pos: [0, 0, 1] }), { silent: true }), front);

  on(lib('swerve', [-11, -11, 3.25], rotZ(0)), front);
  on(lib('swerve', [11, -11, 3.25], rotZ(90)), front);
  on(lib('swerve', [11, 11, 3.25], rotZ(180)), back);
  on(lib('swerve', [-11, 11, 3.25], rotZ(270)), back);

  const z = 1.25;
  on(lib('battery', [0, -10.5, z]), pan);
  on(lib('breaker', [5.6, -10.5, z]), pan);
  on(lib('pdh', [0, 1.5, z]), pan);
  on(lib('roborio', [-9.5, 0, z]), pan);
  on(lib('radio', [9.5, 3, z]), pan);
  on(lib('rsl', [9.5, -3.5, z]), pan);
  on(lib('pigeon', [0, -4.2, z]), pan);
  on(lib('limelight', [0, 11, z], rotZ(180)), pan);
  on(lib('sparkmax', [-5.5, 8, z]), pan);
  on(lib('sparkmax', [5.5, 8, z]), pan);

  // a simple tower with two NEOs so wires have something to climb
  const upL = on(tube('1x1', 18, [-6, 13.5, 3.25], rotY(-90)), back);
  const upR = on(tube('1x1', 18, [6, 13.5, 3.25], rotY(-90)), back);
  on(tube('1x1', 11, [-5.5, 13.5, 20.75]), upL);
  on(lib('neo', [-5.5, 13.5, 14], rotY(-90)), upL);
  on(lib('neo', [5.5, 13.5, 14], rotY(90)), upR);
  void left; void right;

  autowire();
  commit();
  app.emit('doc');
  app.emit('frame-all');
}
