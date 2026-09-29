// Run this locally with: node test-mfapi-connection.js
// It checks whether your machine can reach api.mfapi.in at all, and
// whether the shared calculation module works end-to-end.

const { fetchSchemeHistory } = require('./src/lib/schemeCalculations');

console.log('Testing connection to api.mfapi.in ...\n');

fetchSchemeHistory('119551') // SBI Bluechip Fund — a well-known, always-available code
  .then(h => {
    console.log('✅ SUCCESS');
    console.log('Scheme:', h.meta.scheme_name);
    console.log('History points:', h.data.length);
    console.log('Latest NAV entry:', h.data[0]);
  })
  .catch(e => {
    console.log('❌ FAILED:', e.message);
    console.log('\nIf this failed, the problem is network access to api.mfapi.in from');
    console.log('this machine (firewall, proxy, VPN, antivirus, or DNS blocking it) —');
    console.log('not a bug in the dashboard code. Try opening this URL in your browser:');
    console.log('https://api.mfapi.in/mf/119551');
  });