/* Import the non-API fields from the supplied Fund Watch workbook. */
const path = require('path');
const XLSX = require('xlsx');
const store = require('../services/staticFundDataStore');

const workbookPath = process.argv[2] || 'C:/Users/ss/Desktop/Data Centre/Report AS ON 18-Aug-2026.xlsx';
const workbook = XLSX.readFile(workbookPath, { cellDates: true });
const skip = new Set(['Home', 'Graph Data', 'NFOs', 'Disclaimer']);
const clean = value => String(value ?? '').trim();
const useful = value => clean(value) && clean(value) !== '--';

let imported = 0;
for (const sheetName of workbook.SheetNames) {
  if (skip.has(sheetName)) continue;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  const headingRow = rows.findIndex(row => row.some(cell => clean(cell).toLowerCase().includes('risk measures')));
  if (headingRow < 0) continue;
  const headings = rows[headingRow].map(clean);
  const subheadings = (rows[headingRow + 1] || []).map(clean);
  const indexOf = phrase => headings.findIndex(value => value.toLowerCase().includes(phrase));
  const riskIndex = indexOf('risk measures');
  const marketIndex = indexOf('market capitalisation');
  const sectorIndex = indexOf('amfi sectors');
  const exitIndex = indexOf('exit load');
  if ([riskIndex, marketIndex, sectorIndex, exitIndex].some(i => i < 0)) continue;

  for (const row of rows.slice(headingRow + 2)) {
    const schemeName = clean(row[0]);
    const exitLoad = clean(row[exitIndex]);
    const hasDetails = useful(exitLoad) || [riskIndex, marketIndex, sectorIndex].some(i => useful(row[i]));
    if (!schemeName || !hasDetails || /^(fund watch|as on|.+plan\s*)$/i.test(schemeName)) continue;
    const riskMeasures = {};
    for (let offset = 0; offset < 4; offset++) if (useful(row[riskIndex + offset])) riskMeasures[clean(subheadings[riskIndex + offset] || `Measure ${offset + 1}`)] = row[riskIndex + offset];
    const marketCapitalisation = {};
    for (let offset = 0; offset < 4; offset++) if (useful(row[marketIndex + offset])) marketCapitalisation[clean(subheadings[marketIndex + offset] || `Allocation ${offset + 1}`)] = row[marketIndex + offset];
    const amfiSectors = [];
    for (let offset = 0; offset < 5; offset++) if (useful(row[sectorIndex + offset])) amfiSectors.push(clean(row[sectorIndex + offset]));
    try {
      const existing = store.getBySchemeName(schemeName);
      store.save({ schemeName, category: sheetName, riskMeasures, marketCapitalisation, amfiSectors, exitLoad, source: 'Report AS ON 18-Aug-2026.xlsx' }, existing?.id);
      imported++;
    } catch (error) {
      console.warn(`Skipped ${schemeName}: ${error.message}`);
    }
  }
}
console.log(`Imported ${imported} static fund records into ${path.relative(process.cwd(), path.join(__dirname, '../../data/fund-static-data.sqlite'))}.`);
