import { App } from './app.js';
import { installFeatureHooks } from './features.js';
import { initTheme } from './theme.js';
import { buildCommands } from './commands.js';
import { buildToolbar, buildAppBar } from './ui/toolbar.js';
import { buildBrowser } from './ui/browser.js';
import { buildProps } from './ui/props.js';
import { buildTimeline } from './ui/timeline.js';
import { buildNavBar, buildSketchPalette, buildMarkingMenu, openSearch, openHelp } from './ui/overlays.js';
import { Tutorials } from './tutorials.js';
import { showStart } from './ui/start.js';

const app = new App();
installFeatureHooks(app);
initTheme(app);
const ui = {};
const C = buildCommands(app, ui);

buildAppBar(app, C, ui);
buildToolbar(app, C);
buildBrowser(app);
buildProps(app);
buildTimeline(app);
buildNavBar(app, C);
buildSketchPalette(app, C);
buildMarkingMenu(app, C);
const tutorials = new Tutorials(app);

ui.tutorials = tutorials;
ui.home = () => showStart(app, tutorials);
ui.search = () => openSearch(app, C);
ui.help = () => openHelp(C);
tutorials.onHome = ui.home;
document.getElementById('btn-learn').onclick = () => tutorials.toggle();

app.updateOverlaps();
// Start screen: choose Tutorials, Sketch or 3D Objects (and continue or start fresh).
showStart(app, tutorials, { firstLaunch: true });

// handy for debugging in the browser console
window.minicad = { app, tutorials, commands: C };
