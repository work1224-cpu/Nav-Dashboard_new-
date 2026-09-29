const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');

const router = express.Router();

const SOURCES = {
  vanguard: 'https://advisors.vanguard.com/investments/fund-data/all-products',
  upvalyIpo: 'https://finapi.upvaly.com/api/ipo',
  upvalyHolidays: 'https://finapi.upvaly.com/api/exchange/holidays'
};
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (compatible; NAV-Dashboard/1.0)',
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
};
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCached(key, load) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;
  const value = await load();
  cache.set(key, { createdAt: Date.now(), value });
  return value;
}

function numberOrBlank(value) {
  return Number.isFinite(Number(value)) ? String(Number(value).toFixed(2)) : '';
}

function percentOrBlank(value) {
  return Number.isFinite(Number(value)) ? String(Number(value).toFixed(2)) : '';
}

async function getVanguardFunds() {
  return getCached('vanguard', async () => {
    const { data } = await axios.get(SOURCES.vanguard, {
      headers: { ...browserHeaders, Referer: 'https://advisors.vanguard.com/investments/mutual-funds' },
      timeout: 20_000
    });

    return Object.values(data)
      .filter(fund => fund.classifications?.isMutualFund && fund.ticker)
      .map(fund => ({
        Symbol: fund.ticker,
        'Fund name': fund.longName,
        YTD: percentOrBlank(fund.navReturns?.CYTD),
        '1Y': percentOrBlank(fund.navReturns?.['1YR']),
        '3Y': percentOrBlank(fund.navReturns?.['3YR']),
        '5Y': percentOrBlank(fund.navReturns?.['5YR']),
        '10Y': percentOrBlank(fund.navReturns?.['10YR']),
        'Since Inception': percentOrBlank(fund.navReturns?.ITD),
        'Expense Ratio': percentOrBlank(fund.expenseRatio),
        'SEC Yield': percentOrBlank(fund.yields?.secYield?.percent),
        Dividend: percentOrBlank(fund.yields?.dividendYield?.percent),
        Benchmark: fund.benchmarkLongName || '',
        inceptionDate: fund.inceptionDate || '',
        asOf: fund.navReturns?.dailyEffectiveDate || fund.navReturns?.monthlyEffectiveDate || ''
      }))
      .sort((a, b) => a['Fund name'].localeCompare(b['Fund name']));
  });
}

async function getUpvalyIpos() {
  return getCached('upvaly-ipo', async () => {
    const { data } = await axios.get(SOURCES.upvalyIpo, { headers: browserHeaders, timeout: 20_000 });
    const records = data?.data;
    if (!Array.isArray(records)) throw new Error('Upvaly did not return IPO records');

    return records.map(ipo => ({
      Symbol: ipo.symbol || '',
      Name: ipo.name || '',
      Type: ipo.type || '',
      Status: ipo.status || '',
      'Price Range': ipo.priceRange || '',
      'Lot Size': ipo.lotSize || '',
      'Open Date': ipo.schedule?.startDate || '',
      'Close Date': ipo.schedule?.endDate || '',
      'Listing Date': ipo.schedule?.listingDate || '',
      'Issue Size (Cr.)': ipo.issueSize?.totalIssueSize || '',
      Exchanges: ipo.exchanges || '',
      'Subscription (x)': ipo.subscriptionNumbers?.total?.subscription || '',
      detailsUrl: ipo.detailsUrl || '',
      logoUrl: ipo.logoUrl || '',
      aboutCompany: ipo.aboutCompany || ''
    }));
  });
}

async function getUpvalyHolidays() {
  return getCached('upvaly-holidays', async () => {
    const { data } = await axios.get(SOURCES.upvalyHolidays, { headers: browserHeaders, timeout: 20_000 });
    const records = data?.data;
    if (!Array.isArray(records)) throw new Error('Upvaly did not return holiday records');

    return records.map(h => ({
      Date: h.date || '',
      Description: h.description || '',
      Type: h.holidayType || '',
      'Closed Exchanges': Array.isArray(h.closedExchanges) ? h.closedExchanges.join(', ') : '',
      'Open Exchanges': Array.isArray(h.openExchanges) ? h.openExchanges.map(e => e.exchange).join(', ') : ''
    }));
  });
}

router.get('/vanguard/funds', async (_req, res) => {
  try {
    res.json(await getVanguardFunds());
  } catch (error) {
    console.error('Vanguard API error:', error.message);
    res.status(502).json({ error: 'Unable to fetch current Vanguard data' });
  }
});

router.get('/vanguard/export-all', async (_req, res) => {
  try {
    const funds = await getVanguardFunds();
    if (!funds || funds.length === 0) return res.status(404).json({ error: 'No Vanguard data available' });

    const wsData = [
      ['Symbol', 'Fund Name', 'YTD %', '1Y %', '3Y %', '5Y %', '10Y %', 
       'Since Inception %', 'Expense Ratio', 'SEC Yield', 'Dividend', 'Benchmark']
    ];

    funds.forEach(fund => {
      wsData.push([
        fund.Symbol || 'N/A',
        fund['Fund name'] || 'N/A',
        fund.YTD || 'N/A',
        fund['1Y'] || 'N/A',
        fund['3Y'] || 'N/A',
        fund['5Y'] || 'N/A',
        fund['10Y'] || 'N/A',
        fund['Since Inception'] || 'N/A',
        fund['Expense Ratio'] || 'N/A',
        fund['SEC Yield'] || 'N/A',
        fund.Dividend || 'N/A',
        fund.Benchmark || 'N/A'
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 12 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 40 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Vanguard Funds');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `Vanguard_Funds_${timestamp}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Vanguard error:', error);
    res.status(500).json({ error: 'Failed to export Vanguard data' });
  }
});

router.get('/vanguard/export/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const funds = await getVanguardFunds();
    const fund = funds.find(f => f.Symbol && f.Symbol.toUpperCase() === symbol);
    if (!fund) return res.status(404).json({ error: `Fund with symbol ${symbol} not found` });

    const wsData = [
      ['Field', 'Value'],
      ['Symbol', fund.Symbol || 'N/A'],
      ['Fund Name', fund['Fund name'] || 'N/A'],
      ['YTD %', fund.YTD || 'N/A'],
      ['1 Year %', fund['1Y'] || 'N/A'],
      ['3 Year %', fund['3Y'] || 'N/A'],
      ['5 Year %', fund['5Y'] || 'N/A'],
      ['10 Year %', fund['10Y'] || 'N/A'],
      ['Since Inception %', fund['Since Inception'] || 'N/A'],
      ['Expense Ratio %', fund['Expense Ratio'] || 'N/A'],
      ['SEC Yield', fund['SEC Yield'] || 'N/A'],
      ['Dividend', fund.Dividend || 'N/A'],
      ['Benchmark', fund.Benchmark || 'N/A']
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 25 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Fund Details');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Vanguard_${fund.Symbol}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Vanguard fund error:', error);
    res.status(500).json({ error: 'Failed to export fund data' });
  }
});

router.get('/vanguard/fund/:symbol', async (req, res) => {
  try {
    const fund = (await getVanguardFunds()).find(item => item.Symbol === req.params.symbol.toUpperCase());
    if (!fund) return res.status(404).json({ error: 'Fund not found' });
    res.json(fund);
  } catch (error) {
    console.error('Vanguard API error:', error.message);
    res.status(502).json({ error: 'Unable to fetch current Vanguard data' });
  }
});

router.get('/upvaly/ipo', async (_req, res) => {
  try {
    res.json(await getUpvalyIpos());
  } catch (error) {
    console.error('Upvaly IPO error:', error.message);
    res.status(502).json({ error: 'Unable to fetch current Upvaly IPO data' });
  }
});

router.get('/upvaly/holidays', async (_req, res) => {
  try {
    res.json(await getUpvalyHolidays());
  } catch (error) {
    console.error('Upvaly holidays error:', error.message);
    res.status(502).json({ error: 'Unable to fetch current Upvaly holiday data' });
  }
});

router.get('/upvaly/ipo/export-all', async (_req, res) => {
  try {
    const ipos = await getUpvalyIpos();
    if (!ipos || ipos.length === 0) return res.status(404).json({ error: 'No Upvaly IPO data available' });

    const wsData = [
      ['Symbol', 'Name', 'Type', 'Status', 'Price Range', 'Lot Size', 'Open Date',
       'Close Date', 'Listing Date', 'Issue Size (Cr.)', 'Exchanges', 'Subscription (x)']
    ];
    ipos.forEach(ipo => {
      wsData.push([
        ipo.Symbol || 'N/A', ipo.Name || 'N/A', ipo.Type || 'N/A', ipo.Status || 'N/A',
        ipo['Price Range'] || 'N/A', ipo['Lot Size'] || 'N/A', ipo['Open Date'] || 'N/A',
        ipo['Close Date'] || 'N/A', ipo['Listing Date'] || 'N/A', ipo['Issue Size (Cr.)'] || 'N/A',
        ipo.Exchanges || 'N/A', ipo['Subscription (x)'] || 'N/A'
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 14 }, { wch: 35 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 14 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Upvaly IPOs');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="Upvaly_IPOs_${timestamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Upvaly IPO error:', error);
    res.status(500).json({ error: 'Failed to export Upvaly IPO data' });
  }
});

router.get('/upvaly/holidays/export-all', async (_req, res) => {
  try {
    const holidays = await getUpvalyHolidays();
    if (!holidays || holidays.length === 0) return res.status(404).json({ error: 'No Upvaly holiday data available' });

    const wsData = [
      ['Date', 'Description', 'Type', 'Closed Exchanges', 'Open Exchanges']
    ];
    holidays.forEach(h => {
      wsData.push([
        h.Date || 'N/A', h.Description || 'N/A', h.Type || 'N/A',
        h['Closed Exchanges'] || 'N/A', h['Open Exchanges'] || 'N/A'
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 18 }, { wch: 30 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Upvaly Holidays');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="Upvaly_Holidays_${timestamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Upvaly holidays error:', error);
    res.status(500).json({ error: 'Failed to export Upvaly holiday data' });
  }
});

router.get('/upvaly/ipo/export/:symbol', async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
    const ipos = await getUpvalyIpos();
    const ipo = ipos.find(i => (i.Symbol || '').toUpperCase() === symbol);
    if (!ipo) return res.status(404).json({ error: `IPO with symbol ${symbol} not found` });

    const wsData = [
      ['Field', 'Value'],
      ['Symbol', ipo.Symbol || 'N/A'],
      ['Name', ipo.Name || 'N/A'],
      ['Type', ipo.Type || 'N/A'],
      ['Status', ipo.Status || 'N/A'],
      ['Price Range', ipo['Price Range'] || 'N/A'],
      ['Lot Size', ipo['Lot Size'] || 'N/A'],
      ['Open Date', ipo['Open Date'] || 'N/A'],
      ['Close Date', ipo['Close Date'] || 'N/A'],
      ['Listing Date', ipo['Listing Date'] || 'N/A'],
      ['Issue Size (Cr.)', ipo['Issue Size (Cr.)'] || 'N/A'],
      ['Exchanges', ipo.Exchanges || 'N/A'],
      ['Subscription (x)', ipo['Subscription (x)'] || 'N/A'],
      ['Details URL', ipo.detailsUrl || 'N/A'],
      ['About Company', ipo.aboutCompany || 'N/A']
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 20 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, 'IPO Details');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Upvaly_IPO_${ipo.Symbol || 'scheme'}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Upvaly IPO item error:', error);
    res.status(500).json({ error: 'Failed to export IPO data' });
  }
});

router.get('/upvaly/holidays/export/:date', async (req, res) => {
  try {
    const date = decodeURIComponent(req.params.date);
    const holidays = await getUpvalyHolidays();
    const h = holidays.find(item => item.Date === date);
    if (!h) return res.status(404).json({ error: `Holiday on ${date} not found` });

    const wsData = [
      ['Field', 'Value'],
      ['Date', h.Date || 'N/A'],
      ['Description', h.Description || 'N/A'],
      ['Type', h.Type || 'N/A'],
      ['Closed Exchanges', h['Closed Exchanges'] || 'N/A'],
      ['Open Exchanges', h['Open Exchanges'] || 'N/A']
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 20 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Holiday Details');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Upvaly_Holiday_${h.Date || 'date'}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (error) {
    console.error('Export Upvaly holiday item error:', error);
    res.status(500).json({ error: 'Failed to export holiday data' });
  }
});

module.exports = router;