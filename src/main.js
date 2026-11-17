import './style.css';
import { app, setTool, select } from './app.js';
import { Viewport } from './viewport.js';
import { emptyDoc, loadDoc, loadSaved } from './doc.js';
import { initLabels } from './labels.js';
import { initTools, frameSelection } from './tools.js';
import { sketchTool } from './sketch.js';
import { initUI } from './ui.js';
import { rerouteAll, refreshWireHighlights, rt } from './wiring/wires.js';
import { loadSample } from './sample.js';

const view = document.getElementById('view');
app.vp = new Viewport(view, document.getElementById('gizmo'));
app.doc = emptyDoc();
initLabels(document.getElementById('labels'));
initTools();
app.tools.sketch = sketchTool;
initUI();

// Wires re-route themselves whenever the robot changes.
let wiresDirty = false, selWires = '';
app.on('wires-dirty', () => { wiresDirty = true; });
app.on('wires-vis', () => { for (const r of rt.values()) if (r.group) r.group.visible = app.showWires; });
app.on('sel', () => {
  const s = app.sel.filter((x) => x.t === 'wire').map((x) => x.id).join();
  if (s !== selWires) { selWires = s; refreshWireHighlights(); }
});
app.on('frame-all', () => frameSelection(true));
app.vp.frameHooks.push(() => {
  if (!wiresDirty) return;
  wiresDirty = false;
  rerouteAll();
});

setTool('select');
const saved = loadSaved();
if (saved?.parts?.length) loadDoc(saved); else loadSample();
select([]);
window.app = app; // handy in the console
