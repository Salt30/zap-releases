const { createAppearance } = require('./appearance');
createAppearance();
const render = (text) => { document.getElementById('answer').textContent = text; };
window.dripType.onZapPin(render);
window.dripType.getZapPin().then(render).catch(() => render('The pinned answer could not be loaded.'));
document.getElementById('close').addEventListener('click', () => window.dripType.closeZapPin());
