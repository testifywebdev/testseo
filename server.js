import express from 'express';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import tls from 'tls';
import dns from 'dns/promises';
import { URL } from 'url';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

// Handle __dirname replacement in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Utility function to replace page.waitForTimeout
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve React app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Enhanced Browser Manager (from original code, with minor logging tweaks) ---
class BrowserManager {
  constructor() {
    this.browser = null;
    this.lastUsed = null;
    this.maxIdleTime = 5 * 60 * 1000; // 5 minutes
    this.initAttempts = 0;
    this.maxInitAttempts = 3;
    this.isInitializing = false;
  }

  async getBrowser() {
    if (this.isInitializing) {
      let attempts = 0;
      while (this.isInitializing && attempts < 30) {
        await delay(500);
        attempts++;
      }
    }

    const needsNewBrowser = !this.browser || !this.browser.isConnected() || (this.lastUsed && Date.now() - this.lastUsed > this.maxIdleTime);

    if (needsNewBrowser) {
      this.isInitializing = true;
      try {
        if (this.browser) {
          try {
            await this.browser.close();
          } catch (e) {
            console.error('Error closing old browser:', e.message);
          }
          this.browser = null;
        }

        this.initAttempts = 0;
        while (this.initAttempts < this.maxInitAttempts) {
          try {
            console.log(`Launching new browser instance (attempt ${this.initAttempts + 1}/${this.maxInitAttempts})...`);
            this.browser = await puppeteer.launch({
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
              ],
              headless: true,
              timeout: 60000
            });
            this.initAttempts = 0;
            console.log('Browser launched successfully');
            break;
          } catch (error) {
            this.initAttempts++;
            console.error(`Browser launch attempt ${this.initAttempts} failed:`, error.message);
            if (this.browser) {
              try {
                await this.browser.close();
              } catch (e) { /* ignore cleanup errors */ }
              this.browser = null;
            }
            if (this.initAttempts >= this.maxInitAttempts) {
              throw new Error(`Failed to launch browser after ${this.maxInitAttempts} attempts.`);
            }
            await delay(2000 * this.initAttempts);
          }
        }
      } finally {
        this.isInitializing = false;
      }
    }
    if (!this.browser || !this.browser.isConnected()) {
      throw new Error('Browser is not available or connected');
    }
    this.lastUsed = Date.now();
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log('Browser closed successfully');
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }

  async isBrowserHealthy() {
    if (!this.browser) return false;
    try {
      return this.browser.isConnected();
    } catch (error) {
      return false;
    }
  }
}

const browserManager = new BrowserManager();

// --- Analysis Helper Functions ---

async function getPageContent(targetUrl) {
    let page = null;
    let browser = null;
    try {
        browser = await browserManager.getBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.setDefaultNavigationTimeout(60000); // 60 second timeout for navigation

        const response = await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        
        if (!response) {
            throw new Error('No response received from the server.');
        }

        const status = response.status();
        if (status >= 400) {
            throw new Error(`HTTP Error: Received status code ${status}`);
        }

        const content = await page.content();
        const headers = response.headers();
        const consoleErrors = [];
        page.on('pageerror', error => {
            consoleErrors.push(error.message);
        });

        await delay(1000); // Wait a bit for async errors to be captured

        return { content, headers, consoleErrors };
    } finally {
        if (page) {
            await page.close();
        }
    }
}

async function runLighthouseAnalysis(targetUrl) {
    let chrome = null;
    try {
        console.log('Starting Lighthouse analysis...');
        chrome = await chromeLauncher.launch({
            chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        });
        const options = {
            logLevel: 'error',
            output: 'json',
            onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
            port: chrome.port,
            emulatedFormFactor: 'desktop'
        };

        const runnerResult = await lighthouse(targetUrl, options, undefined);
        console.log('Lighthouse analysis finished.');

        if (!runnerResult || !runnerResult.lhr) {
            throw new Error('Lighthouse returned no results.');
        }

        const { categories, audits } = runnerResult.lhr;
        return {
            performance: Math.round((categories.performance?.score || 0) * 100),
            accessibility: Math.round((categories.accessibility?.score || 0) * 100),
            bestPractices: Math.round((categories['best-practices']?.score || 0) * 100),
            seo: Math.round((categories.seo?.score || 0) * 100),
            firstContentfulPaint: audits['first-contentful-paint']?.displayValue || 'N/A',
            largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || 'N/A',
            speedIndex: audits['speed-index']?.displayValue || 'N/A',
            cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue || 'N/A',
            renderBlockingResources: audits['render-blocking-resources']?.details?.items?.length || 0,
        };
    } finally {
        if (chrome) {
            await chrome.kill();
        }
    }
}

async function getSslInfo(hostname) {
    return new Promise((resolve, reject) => {
        const options = { host: hostname, port: 443, servername: hostname, rejectUnauthorized: false };
        const socket = tls.connect(options, () => {
            const cert = socket.getPeerCertificate();
            socket.end();
            if (!cert || Object.keys(cert).length === 0) {
                return reject(new Error('No SSL certificate found.'));
            }
            resolve({
                subject: cert.subject?.CN || 'N/A',
                issuer: cert.issuer?.CN || 'N/A',
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
                isExpired: new Date(cert.valid_to) < new Date(),
            });
        });
        socket.on('error', (err) => reject(err));
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error('SSL connection timed out.'));
        });
    });
}


function calculateScores(results) {
    const categories = ['commonSeo', 'speed', 'security', 'mobile', 'advancedSeo'];
    categories.forEach(cat => {
        const category = results[cat];
        const totalChecks = category.passed.length + category.failed.length + category.warnings.length;
        if (totalChecks > 0) {
            const score = ((category.passed.length + (category.warnings.length * 0.5)) / totalChecks) * 100;
            category.score = Math.round(score);
        } else {
            category.score = 100; // Default to 100 if no checks were run
        }
    });

    // Calculate overall score (weighted average)
    const weights = { commonSeo: 0.3, speed: 0.3, security: 0.15, mobile: 0.15, advancedSeo: 0.1 };
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const cat in weights) {
        if(results[cat]){
            totalScore += results[cat].score * weights[cat];
            totalWeight += weights[cat];
        }
    }
    
    results.overallScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
    results.totalPassed = results.commonSeo.passed.length + results.speed.passed.length + results.security.passed.length + results.mobile.passed.length + results.advancedSeo.passed.length;
    results.totalWarnings = results.commonSeo.warnings.length + results.speed.warnings.length + results.security.warnings.length + results.mobile.warnings.length + results.advancedSeo.warnings.length;
    results.totalFailed = results.commonSeo.failed.length + results.speed.failed.length + results.security.failed.length + results.mobile.failed.length + results.advancedSeo.failed.length;
}


// --- Main Analysis Endpoint ---

app.post('/api/analyze', async (req, res) => {
    const { url: targetUrl } = req.body;
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format. Please include http:// or https://' });
    }

    const analysisStartTime = Date.now();
    console.log(`Starting analysis for: ${targetUrl}`);

    try {
        // --- 1. Fetch and Parse Content ---
        const { content, headers, consoleErrors } = await getPageContent(targetUrl);
        const $ = cheerio.load(content);

        const results = {
            analyzedUrl: targetUrl,
            overallScore: 0,
            totalFailed: 0,
            totalWarnings: 0,
            totalPassed: 0,
            commonSeo: { score: 0, failed: [], warnings: [], passed: [] },
            speed: { score: 0, failed: [], warnings: [], passed: [] },
            security: { score: 0, failed: [], warnings: [], passed: [] },
            mobile: { score: 0, failed: [], warnings: [], passed: [] },
            advancedSeo: { score: 0, failed: [], warnings: [], passed: [] },
            metaInfo: {},
            technicalInfo: {},
            lighthouseReport: {},
            sslInfo: {},
        };

        // --- 2. Run All Checks in Parallel ---
        const lighthousePromise = runLighthouseAnalysis(targetUrl).catch(err => {
            console.error("Lighthouse analysis failed:", err.message);
            return { error: 'Lighthouse analysis failed or timed out.', message: err.message };
        });
        
        const sslPromise = parsedUrl.protocol === 'https:' ? getSslInfo(parsedUrl.hostname).catch(err => {
            console.error("SSL analysis failed:", err.message);
            return { error: 'SSL Info not available.', message: err.message };
        }) : Promise.resolve({ info: 'Site is not using HTTPS.'});


        // --- 3. Perform Cheerio-based checks while async checks run ---
        
        // Common SEO Checks
        const title = $('title').text().trim();
        results.metaInfo.title = title || 'Missing title tag';
        if (title) {
            if (title.length > 10 && title.length < 70) results.commonSeo.passed.push(`Title tag is a good length (${title.length} characters).`);
            else results.commonSeo.warnings.push(`Title tag length is ${title.length} characters. Recommended is 10-70.`);
        } else {
            results.commonSeo.failed.push('Missing title tag.');
        }

        const metaDescription = $('meta[name="description"]').attr('content')?.trim();
        results.metaInfo.metaDescription = metaDescription || 'Missing meta description tag.';
        if (metaDescription) {
            if (metaDescription.length > 70 && metaDescription.length < 160) results.commonSeo.passed.push(`Meta description is a good length (${metaDescription.length} characters).`);
            else results.commonSeo.warnings.push(`Meta description length is ${metaDescription.length} characters. Recommended is 70-160.`);
        } else {
            results.commonSeo.failed.push('Missing meta description tag.');
        }

        const h1Count = $('h1').length;
        if (h1Count === 1) results.commonSeo.passed.push('Page has exactly one H1 tag.');
        else if (h1Count === 0) results.commonSeo.failed.push('Page is missing an H1 tag.');
        else results.commonSeo.warnings.push(`Page has ${h1Count} H1 tags. Only one is recommended.`);
        
        const imgCount = $('img').length;
        const imgsWithoutAlt = $('img:not([alt]), img[alt=""]').length;
        if (imgCount > 0) {
            if (imgsWithoutAlt === 0) results.commonSeo.passed.push(`All ${imgCount} images have alt attributes.`);
            else results.commonSeo.failed.push(`${imgsWithoutAlt} out of ${imgCount} images are missing descriptive alt attributes.`);
        }

        if (consoleErrors.length === 0) results.commonSeo.passed.push('No JavaScript errors detected in the console.');
        else results.commonSeo.warnings.push(`Detected ${consoleErrors.length} JavaScript errors in the console.`);
        results.technicalInfo.consoleErrors = consoleErrors;

        // Speed Checks
        const inlineCssCount = $('style').length + $('[style]').length;
        if (inlineCssCount > 10) results.speed.warnings.push(`High use of inline CSS (${inlineCssCount} instances). Consider moving to external stylesheets.`);
        else results.speed.passed.push('Low usage of inline CSS styles.');

        const htmlSize = Buffer.byteLength(content, 'utf-8') / 1024; // in KB
        results.technicalInfo.htmlSizeKB = parseFloat(htmlSize.toFixed(2));
        if (htmlSize < 50) results.speed.passed.push(`HTML page size is small (${results.technicalInfo.htmlSizeKB} KB).`);
        else results.speed.warnings.push(`HTML page size is ${results.technicalInfo.htmlSizeKB} KB. Consider reducing it.`);

        // Security Checks
        if (parsedUrl.protocol === 'https:') {
            results.security.passed.push('Site uses HTTPS, which is secure.');
            if (content.includes('http://')) results.security.warnings.push('Mixed content warning: Page loads assets over insecure HTTP.');
            else results.security.passed.push('No mixed content (HTTP assets on HTTPS page) detected.');
        } else {
            results.security.failed.push('Site does not use HTTPS. This is a major security risk.');
        }

        if (headers['strict-transport-security']) results.security.passed.push('HTTP Strict Transport Security (HSTS) header is present.');
        else results.security.warnings.push('HSTS header is not present, leaving the site vulnerable to man-in-the-middle attacks.');

        if (!headers['server']) results.security.passed.push('Server signature is hidden, which is a good security practice.');
        else results.security.warnings.push(`Server signature is visible: ${headers['server']}.`);
        
        // Mobile Checks
        const viewport = $('meta[name="viewport"]').attr('content');
        if (viewport && viewport.includes('width=device-width')) results.mobile.passed.push('A mobile-friendly viewport is configured.');
        else results.mobile.failed.push('Viewport meta tag is missing or misconfigured.');

        // Advanced SEO Checks
        const canonical = $('link[rel="canonical"]').attr('href');
        if (canonical) results.advancedSeo.passed.push(`Canonical tag found, pointing to: ${canonical}`);
        else results.advancedSeo.warnings.push('No canonical tag found. This can lead to duplicate content issues.');
        results.metaInfo.canonical = canonical || 'N/A';
        
        if ($('script[type="application/ld+json"]').length > 0) results.advancedSeo.passed.push('Structured data (JSON-LD) was found on the page.');
        else results.advancedSeo.warnings.push('No structured data (JSON-LD) was found.');

        if ($('link[rel*="icon"]').length > 0) results.advancedSeo.passed.push('A favicon is specified.');
        else results.advancedSeo.failed.push('Favicon link is missing.');

        // --- 4. Await and Process Async Results ---
        results.lighthouseReport = await lighthousePromise;
        if (!results.lighthouseReport.error) {
            results.speed.score = results.lighthouseReport.performance;
            results.mobile.score = results.lighthouseReport.accessibility;
            // Add Lighthouse data to checks
            if(results.lighthouseReport.renderBlockingResources === 0) {
                results.speed.passed.push('No render-blocking resources found by Lighthouse.');
            } else {
                results.speed.failed.push(`Lighthouse detected ${results.lighthouseReport.renderBlockingResources} render-blocking resources.`);
            }
        }
        
        results.sslInfo = await sslPromise;
        if (!results.sslInfo.error && results.sslInfo.subject) {
            if(results.sslInfo.isExpired) {
                results.security.failed.push(`SSL certificate expired on ${results.sslInfo.validTo}.`);
            } else {
                results.security.passed.push(`SSL certificate is valid until ${results.sslInfo.validTo}.`);
            }
        } else if (results.sslInfo.error) {
            results.security.warnings.push(`Could not verify SSL certificate: ${results.sslInfo.error}`);
        }

        // --- 5. Calculate Final Scores and Send Response ---
        calculateScores(results);
        results.analysisTimeMs = Date.now() - analysisStartTime;
        console.log(`Analysis for ${targetUrl} completed in ${results.analysisTimeMs}ms. Score: ${results.overallScore}`);

        res.json(results);

    } catch (error) {
        console.error(`[Analysis Error] for ${targetUrl}:`, error);
        res.status(500).json({
            error: 'Failed to analyze URL.',
            details: error.message,
            suggestions: [
                'Ensure the URL is correct and the website is online.',
                'The website may be blocking automated tools or requests.',
                'The server may be down or experiencing high traffic.'
            ]
        });
    }
});


// --- Server Start and Health Checks ---

app.get('/api/health', async (req, res) => {
  const browserHealth = await browserManager.isBrowserHealthy();
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    browserHealthy: browserHealth
  });
});

app.listen(PORT, () => {
  console.log(`SEO Analyzer server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);
  await browserManager.closeBrowser();
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
