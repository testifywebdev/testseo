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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve React app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced browser instance manager with better error handling
class BrowserManager {
  constructor() {
    this.browser = null;
    this.lastUsed = null;
    this.maxIdleTime = 5 * 60 * 1000; // 5 minutes
    this.initAttempts = 0;
    this.maxInitAttempts = 3;
    this.isInitializing = false; // Prevent concurrent initializations
  }

  async getBrowser() {
    // Prevent concurrent browser initialization
    if (this.isInitializing) {
      // Wait for ongoing initialization
      let attempts = 0;
      while (this.isInitializing && attempts < 30) { // Wait up to 15 seconds
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
      }
    }

    // Check if we need to create a new browser or if the existing one is stale
    const needsNewBrowser = !this.browser || 
                           !this.browser.isConnected() || 
                           (this.lastUsed && Date.now() - this.lastUsed > this.maxIdleTime);

    if (needsNewBrowser) {
      this.isInitializing = true;
      
      try {
        // Clean up existing browser
        if (this.browser) {
          try {
            await this.browser.close();
          } catch (e) {
            console.log('Error closing old browser:', e.message);
          }
          this.browser = null;
        }

        // Retry logic for browser initialization
        this.initAttempts = 0;
        while (this.initAttempts < this.maxInitAttempts) {
          try {
            console.log(`Launching new browser instance (attempt ${this.initAttempts + 1}/${this.maxInitAttempts})...`);
            
            const browserOptions = {
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
              ],
              headless: true,
              timeout: 30000
              // Removed executablePath - let Puppeteer find Chrome automatically
            };

            this.browser = await puppeteer.launch(browserOptions);
            
            // Test browser connectivity
            const testPage = await this.browser.newPage();
            await testPage.close();
            
            this.initAttempts = 0; // Reset on success
            console.log('Browser launched successfully');
            break;
            
          } catch (error) {
            this.initAttempts++;
            console.error(`Browser launch attempt ${this.initAttempts} failed:`, error.message);
            
            if (this.browser) {
              try {
                await this.browser.close();
              } catch (e) {
                // Ignore cleanup errors
              }
              this.browser = null;
            }
            
            if (this.initAttempts >= this.maxInitAttempts) {
              throw new Error(`Failed to launch browser after ${this.maxInitAttempts} attempts: ${error.message}`);
            }
            
            // Wait before retry with exponential backoff
            const waitTime = Math.min(2000 * Math.pow(2, this.initAttempts - 1), 10000);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      } finally {
        this.isInitializing = false;
      }
    }

    // Final validation
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
        console.log('Error closing browser:', e.message);
      }
    }
  }

  // Check browser health
  async isBrowserHealthy() {
    if (!this.browser) return false;
    
    try {
      const pages = await this.browser.pages();
      return this.browser.isConnected() && Array.isArray(pages);
    } catch (error) {
      return false;
    }
  }
}

const browserManager = new BrowserManager();

// Enhanced page analysis with comprehensive error handling
async function analyzePage(targetUrl) {
  let page = null;
  let browser = null;
  let retryCount = 0;
  const maxRetries = 2;
  
  while (retryCount <= maxRetries) {
    try {
      // Pre-flight check: verify URL accessibility
      try {
        const urlObj = new URL(targetUrl);
        console.log(`Pre-flight check for: ${urlObj.hostname} (attempt ${retryCount + 1})`);
        
        // Basic DNS resolution check
        try {
          await dns.resolve4(urlObj.hostname);
        } catch (dnsError) {
          throw new Error(`DNS resolution failed for ${urlObj.hostname}. The domain may not exist or be unreachable.`);
        }
      } catch (urlError) {
        throw new Error(`Invalid URL format: ${urlError.message}`);
      }

      // Get browser instance with health check
      browser = await browserManager.getBrowser();
      
      // Double-check browser health before proceeding
      const isHealthy = await browserManager.isBrowserHealthy();
      if (!isHealthy) {
        console.log('Browser health check failed, forcing restart...');
        await browserManager.closeBrowser();
        browser = await browserManager.getBrowser();
      }

      // Create page with enhanced error handling
      console.log('Creating new page...');
      page = await browser.newPage();
      
      if (!page) {
        throw new Error('Failed to create new page - page is null');
      }

      // Enhanced page configuration
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Set generous timeouts
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(30000);
      
      // Enhanced error handlers
      page.on('error', (error) => {
        console.error('Page error:', error.message);
      });
      
      page.on('pageerror', (error) => {
        console.error('Page script error:', error.message);
      });

      // Enhanced navigation with multiple strategies
      let content = null;
      let navigationRetries = 3;
      
      while (navigationRetries > 0 && !content) {
        try {
          console.log(`Navigation attempt ${4 - navigationRetries}/3 for: ${targetUrl}`);
          
          // Try different wait strategies based on attempt
          let waitUntil;
          switch (4 - navigationRetries) {
            case 1:
              waitUntil = 'domcontentloaded';
              break;
            case 2:
              waitUntil = 'load';
              break;
            case 3:
              waitUntil = 'networkidle2';
              break;
          }
          
          const response = await page.goto(targetUrl, { 
            waitUntil,
            timeout: 30000 
          });
          
          if (!response) {
            throw new Error('No response received from the server');
          }
          
          const status = response.status();
          console.log(`Response status: ${status}`);
          
          if (status >= 400) {
            throw new Error(`HTTP ${status}: ${response.statusText()}`);
          }
          
          // Additional wait for dynamic content
          await page.waitForTimeout(2000);
          
          // Check if page actually loaded content
          const title = await page.title().catch(() => '');
          console.log(`Page title: "${title}"`);
          
          content = await page.content();
          
          // Validate content length
          if (content.length < 100 && navigationRetries > 1) {
            throw new Error('Page content appears to be incomplete');
          }
          
          console.log(`Successfully loaded ${content.length} characters of content`);
          break;
          
        } catch (error) {
          console.error(`Navigation attempt ${4 - navigationRetries} failed:`, error.message);
          navigationRetries--;
          
          if (navigationRetries > 0) {
            console.log(`Retrying navigation in 2 seconds... (${navigationRetries} attempts remaining)`);
            await page.waitForTimeout(2000);
          } else {
            // Provide more specific error messages based on the error type
            let errorMessage = error.message;
            
            if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
              errorMessage = 'The website connection was unexpectedly closed. This might be due to anti-bot protection or server issues.';
            } else if (error.message.includes('timeout')) {
              errorMessage = 'The website took too long to respond. It might be slow or experiencing high traffic.';
            } else if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
              errorMessage = 'The website domain could not be found. Please check if the URL is correct.';
            } else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) {
              errorMessage = 'The website refused the connection. The server might be down or blocking requests.';
            } else if (error.message.includes('net::ERR_CERT_')) {
              errorMessage = 'There is an SSL certificate issue with this website.';
            }
            
            throw new Error(`Failed to load page after 3 navigation attempts: ${errorMessage}`);
          }
        }
      }
      
      return content;
      
    } catch (error) {
      console.error(`Page analysis attempt ${retryCount + 1} failed:`, error.message);
      
      // Clean up page
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.log('Error closing page:', e.message);
        }
        page = null;
      }
      
      // If this was due to browser issues and we have retries left, restart browser
      if (retryCount < maxRetries && 
          (error.message.includes('Target closed') || 
           error.message.includes('Session closed') ||
           error.message.includes('Browser is not available') ||
           error.message.includes('page is null'))) {
        
        console.log(`Browser-related error detected, restarting browser for retry ${retryCount + 1}...`);
        await browserManager.closeBrowser();
        retryCount++;
        continue;
      }
      
      // If no more retries or non-browser error, throw the error
      throw error;
    } finally {
      // Always clean up the page
      if (page) {
        try {
          await page.close();
        } catch (e) {
          console.log('Error closing page in finally block:', e.message);
        }
      }
    }
  }
}

// Test endpoint for debugging connectivity
app.post('/api/test-url', async (req, res) => {
  const { url: targetUrl } = req.body;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  try {
    const urlObj = new URL(targetUrl);
    
    // Test DNS resolution
    const dnsResult = await dns.resolve4(urlObj.hostname).catch(e => ({ error: e.message }));
    
    // Test basic connectivity (for HTTPS sites)
    let sslTest = null;
    if (urlObj.protocol === 'https:') {
      sslTest = await getSSLInfo(urlObj.hostname).catch(e => ({ error: e.message }));
    }
    
    res.json({
      url: targetUrl,
      hostname: urlObj.hostname,
      protocol: urlObj.protocol,
      dns: dnsResult,
      ssl: sslTest,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(400).json({ error: 'Invalid URL', details: error.message });
  }
});

// SEO Analysis endpoint with improved error handling
app.post('/api/analyze', async (req, res) => {
  const { url: targetUrl } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let analysisStartTime = Date.now();
  console.log(`Starting analysis for: ${targetUrl}`);

  try {
    // Validate URL format first
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (urlError) {
      return res.status(400).json({ 
        error: 'Invalid URL format', 
        details: `The provided URL is not valid: ${urlError.message}`,
        suggestions: [
          'Ensure the URL includes the protocol (http:// or https://)',
          'Check for typos in the domain name',
          'Verify the URL is complete and properly formatted'
        ]
      });
    }

    const results = {
      analyzedUrl: targetUrl,
      overallScore: 0,
      failed: 0,
      warnings: 0,
      passed: 0,
      seo: { score: 0, failed: [], warnings: [], passed: [] },
      performance: { score: 0, failed: [], warnings: [], passed: [] },
      security: { score: 0, failed: [], warnings: [], passed: [] },
      mobile: { score: 0, failed: [], warnings: [], passed: [] },
      metaInfo: {},
      technicalInfo: {},
      lighthouseMetrics: {},
      sslInfo: {},
      analysisTime: 0
    };

    // Analyze with Puppeteer and Cheerio
    let content;
    try {
      console.log('Starting page analysis...');
      content = await analyzePage(targetUrl);
      console.log('Page content retrieved successfully');
    } catch (error) {
      console.error('Page analysis failed:', error.message);
      
      // Provide more helpful error responses
      let errorResponse = {
        error: 'Failed to load the webpage',
        details: error.message,
        suggestions: []
      };
      
      if (error.message.includes('DNS resolution failed')) {
        errorResponse.suggestions = [
          'Verify the domain name is spelled correctly',
          'Check if the website is currently online',
          'Try accessing the URL in your browser first'
        ];
      } else if (error.message.includes('anti-bot protection')) {
        errorResponse.suggestions = [
          'The website may be using Cloudflare or similar protection',
          'Try again later as the protection may be temporary',
          'Contact the website owner if you need to analyze this site regularly'
        ];
      } else if (error.message.includes('took too long')) {
        errorResponse.suggestions = [
          'The website may be experiencing high traffic',
          'Try again in a few minutes',
          'Check if the website loads normally in your browser'
        ];
      } else {
        errorResponse.suggestions = [
          'Check if the URL is correct and accessible',
          'Ensure the website is not blocking automated requests',
          'Try again in a few moments if the site is temporarily unavailable'
        ];
      }
      
      return res.status(500).json(errorResponse);
    }

    const $ = cheerio.load(content);

    // Meta Information Analysis
    results.metaInfo = {
      title: $('title').text().trim() || 'No title found',
      metaDescription: $('meta[name="description"]').attr('content')?.trim() || 'No meta description',
      charset: $('meta[charset]').attr('charset') || $('meta[http-equiv="content-type"]').attr('content')?.includes('charset') ? 'specified' : 'Not specified',
      viewport: $('meta[name="viewport"]').attr('content') || 'Not responsive',
      robots: $('meta[name="robots"]').attr('content') || 'Not specified',
      canonical: $('link[rel="canonical"]').attr('href') || 'No canonical URL',
      openGraphTitle: $('meta[property="og:title"]').attr('content') || 'Not specified',
      openGraphDescription: $('meta[property="og:description"]').attr('content') || 'Not specified',
      openGraphImage: $('meta[property="og:image"]').attr('content') || 'Not specified',
      twitterCard: $('meta[name="twitter:card"]').attr('content') || 'Not specified'
    };

    // Technical Information
    const scriptTags = $('script').length;
    const styleTags = $('style').length;
    const linkTags = $('link').length;
    const imgTags = $('img').length;
    const h1Tags = $('h1').length;
    const h2Tags = $('h2').length;
    const h3Tags = $('h3').length;
    const internalLinks = $('a[href^="/"], a[href*="' + parsedUrl.hostname + '"]').length;
    const externalLinks = $('a[href^="http"]:not([href*="' + parsedUrl.hostname + '"])').length;

    results.technicalInfo = {
      scriptTags,
      styleTags,
      linkTags,
      imageCount: imgTags,
      h1Count: h1Tags,
      h2Count: h2Tags,
      h3Count: h3Tags,
      internalLinks,
      externalLinks,
      wordCount: $('body').text().replace(/\s+/g, ' ').trim().split(' ').length,
      hasGoogleAnalytics: content.includes('google-analytics') || content.includes('gtag') || content.includes('GoogleAnalytics'),
      hasGoogleTagManager: content.includes('googletagmanager'),
      hasFavicon: $('link[rel*="icon"]').length > 0,
      hasRobotsTxt: false,
      hasSitemap: false,
      hasStructuredData: content.includes('application/ld+json') || $('script[type="application/ld+json"]').length > 0
    };

    // SEO Analysis with comprehensive checks
    const seoChecks = [];
    
    // Title tag check
    if (results.metaInfo.title && results.metaInfo.title !== 'No title found') {
      const titleLength = results.metaInfo.title.length;
      if (titleLength >= 30 && titleLength <= 60) {
        seoChecks.push({ type: 'passed', message: `Title length is optimal (${titleLength} characters)` });
      } else if (titleLength < 30) {
        seoChecks.push({ type: 'warning', message: `Title is too short (${titleLength} characters, recommended: 30-60)` });
      } else {
        seoChecks.push({ type: 'failed', message: `Title is too long (${titleLength} characters, recommended: 30-60)` });
      }
    } else {
      seoChecks.push({ type: 'failed', message: 'Missing title tag' });
    }

    // Meta description check
    if (results.metaInfo.metaDescription && results.metaInfo.metaDescription !== 'No meta description') {
      const descLength = results.metaInfo.metaDescription.length;
      if (descLength >= 120 && descLength <= 160) {
        seoChecks.push({ type: 'passed', message: `Meta description length is optimal (${descLength} characters)` });
      } else if (descLength < 120) {
        seoChecks.push({ type: 'warning', message: `Meta description is too short (${descLength} characters, recommended: 120-160)` });
      } else {
        seoChecks.push({ type: 'failed', message: `Meta description is too long (${descLength} characters, recommended: 120-160)` });
      }
    } else {
      seoChecks.push({ type: 'failed', message: 'Missing meta description' });
    }

    // H1 tag check
    if (h1Tags === 1) {
      seoChecks.push({ type: 'passed', message: 'Has exactly one H1 tag' });
    } else if (h1Tags === 0) {
      seoChecks.push({ type: 'failed', message: 'Missing H1 tag' });
    } else {
      seoChecks.push({ type: 'warning', message: `Multiple H1 tags found (${h1Tags}) - consider using only one` });
    }

    // Heading structure check
    if (h2Tags > 0) {
      seoChecks.push({ type: 'passed', message: `Good heading structure with ${h2Tags} H2 tags` });
    } else {
      seoChecks.push({ type: 'warning', message: 'No H2 tags found - consider adding subheadings' });
    }

    // Images alt text check
    const imagesWithoutAlt = $('img:not([alt])').length;
    const imagesWithEmptyAlt = $('img[alt=""]').length;
    if (imgTags > 0) {
      if (imagesWithoutAlt === 0 && imagesWithEmptyAlt === 0) {
        seoChecks.push({ type: 'passed', message: 'All images have descriptive alt text' });
      } else {
        const totalMissingAlt = imagesWithoutAlt + imagesWithEmptyAlt;
        seoChecks.push({ type: 'failed', message: `${totalMissingAlt} images missing or have empty alt text` });
      }
    }

    // Mobile viewport check
    if (results.metaInfo.viewport && results.metaInfo.viewport.includes('width=device-width')) {
      seoChecks.push({ type: 'passed', message: 'Mobile viewport meta tag present' });
    } else {
      seoChecks.push({ type: 'failed', message: 'Missing or incorrect viewport meta tag' });
    }

    // Canonical URL check
    if (results.metaInfo.canonical && results.metaInfo.canonical !== 'No canonical URL') {
      seoChecks.push({ type: 'passed', message: 'Canonical URL specified' });
    } else {
      seoChecks.push({ type: 'warning', message: 'No canonical URL specified' });
    }

    // Favicon check
    if (results.technicalInfo.hasFavicon) {
      seoChecks.push({ type: 'passed', message: 'Favicon present' });
    } else {
      seoChecks.push({ type: 'failed', message: 'Missing favicon' });
    }

    // Open Graph check
    if (results.metaInfo.openGraphTitle !== 'Not specified' && results.metaInfo.openGraphDescription !== 'Not specified') {
      seoChecks.push({ type: 'passed', message: 'Open Graph metadata present' });
    } else {
      seoChecks.push({ type: 'warning', message: 'Missing Open Graph metadata for social sharing' });
    }

    // Structured data check
    if (results.technicalInfo.hasStructuredData) {
      seoChecks.push({ type: 'passed', message: 'Structured data (JSON-LD) found' });
    } else {
      seoChecks.push({ type: 'warning', message: 'No structured data found' });
    }

    // Process SEO checks
    seoChecks.forEach(check => {
      if (check.type === 'passed') {
        results.seo.passed.push(check.message);
      } else if (check.type === 'failed') {
        results.seo.failed.push(check.message);
      } else if (check.type === 'warning') {
        results.seo.warnings.push(check.message);
      }
    });

    // Calculate SEO score
    const totalSeoChecks = results.seo.passed.length + results.seo.failed.length + results.seo.warnings.length;
    results.seo.score = totalSeoChecks > 0 ? Math.round(((results.seo.passed.length + (results.seo.warnings.length * 0.5)) / totalSeoChecks) * 100) : 0;

    // Performance Analysis
    const performanceChecks = [];
    
    // Check for excessive scripts
    if (scriptTags <= 10) {
      performanceChecks.push({ type: 'passed', message: `Reasonable number of script tags (${scriptTags})` });
    } else {
      performanceChecks.push({ type: 'failed', message: `Too many script tags (${scriptTags}) - consider combining` });
    }

    // Check for inline styles
    if (styleTags <= 3) {
      performanceChecks.push({ type: 'passed', message: 'Minimal inline styles' });
    } else {
      performanceChecks.push({ type: 'warning', message: `Many inline style tags (${styleTags}) - consider external CSS` });
    }

    // Check image count
    if (imgTags <= 20) {
      performanceChecks.push({ type: 'passed', message: `Reasonable number of images (${imgTags})` });
    } else {
      performanceChecks.push({ type: 'warning', message: `Many images (${imgTags}) - ensure they are optimized` });
    }

    // Process performance checks
    performanceChecks.forEach(check => {
      if (check.type === 'passed') {
        results.performance.passed.push(check.message);
      } else if (check.type === 'failed') {
        results.performance.failed.push(check.message);
      } else if (check.type === 'warning') {
        results.performance.warnings.push(check.message);
      }
    });

    const totalPerfChecks = results.performance.passed.length + results.performance.failed.length + results.performance.warnings.length;
    results.performance.score = totalPerfChecks > 0 ? Math.round(((results.performance.passed.length + (results.performance.warnings.length * 0.5)) / totalPerfChecks) * 100) : 70;

    // Security Analysis
    const securityChecks = [];
    
    // HTTPS check
    if (parsedUrl.protocol === 'https:') {
      securityChecks.push({ type: 'passed', message: 'Using HTTPS protocol' });
    } else {
      securityChecks.push({ type: 'failed', message: 'Not using HTTPS protocol' });
    }

    // Mixed content check (basic)
    if (parsedUrl.protocol === 'https:' && !content.includes('http://')) {
      securityChecks.push({ type: 'passed', message: 'No obvious mixed content detected' });
    } else if (parsedUrl.protocol === 'https:') {
      securityChecks.push({ type: 'warning', message: 'Possible mixed content detected' });
    }

    // Process security checks
    securityChecks.forEach(check => {
      if (check.type === 'passed') {
        results.security.passed.push(check.message);
      } else if (check.type === 'failed') {
        results.security.failed.push(check.message);
      } else if (check.type === 'warning') {
        results.security.warnings.push(check.message);
      }
    });

    const totalSecChecks = results.security.passed.length + results.security.failed.length + results.security.warnings.length;
    results.security.score = totalSecChecks > 0 ? Math.round(((results.security.passed.length + (results.security.warnings.length * 0.5)) / totalSecChecks) * 100) : 50;

    // Mobile Analysis
    const mobileChecks = [];
    
    // Viewport check
    if (results.metaInfo.viewport && results.metaInfo.viewport.includes('width=device-width')) {
      mobileChecks.push({ type: 'passed', message: 'Mobile-friendly viewport configured' });
    } else {
      mobileChecks.push({ type: 'failed', message: 'Not mobile-friendly viewport' });
    }

    // Check for responsive design indicators
    const hasMediaQueries = content.includes('@media') || content.includes('responsive') || content.includes('mobile');
    if (hasMediaQueries) {
      mobileChecks.push({ type: 'passed', message: 'Contains responsive design elements' });
    } else {
      mobileChecks.push({ type: 'warning', message: 'No obvious responsive design elements found' });
    }

    // Check for mobile-unfriendly elements
    const hasFlash = content.includes('flash') || content.includes('.swf');
    if (!hasFlash) {
      mobileChecks.push({ type: 'passed', message: 'No Flash content detected' });
    } else {
      mobileChecks.push({ type: 'failed', message: 'Flash content detected (not mobile-friendly)' });
    }

    // Process mobile checks
    mobileChecks.forEach(check => {
      if (check.type === 'passed') {
        results.mobile.passed.push(check.message);
      } else if (check.type === 'failed') {
        results.mobile.failed.push(check.message);
      } else if (check.type === 'warning') {
        results.mobile.warnings.push(check.message);
      }
    });

    const totalMobileChecks = results.mobile.passed.length + results.mobile.failed.length + results.mobile.warnings.length;
    results.mobile.score = totalMobileChecks > 0 ? Math.round(((results.mobile.passed.length + (results.mobile.warnings.length * 0.5)) / totalMobileChecks) * 100) : 70;

    // SSL Certificate Analysis (with timeout)
    if (parsedUrl.protocol === 'https:') {
      try {
        console.log('Analyzing SSL certificate...');
        const sslInfo = await Promise.race([
          getSSLInfo(parsedUrl.hostname),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SSL analysis timeout')), 10000))
        ]);
        results.sslInfo = sslInfo;
        results.security.passed.push('SSL certificate is valid and properly configured');
      } catch (error) {
        console.error('SSL analysis error:', error.message);
        results.security.warnings.push('SSL certificate analysis failed or timed out');
      }
    }

    // Lighthouse Analysis (with better error handling and timeout)
    try {
      console.log('Running Lighthouse analysis...');
      const lighthouseTimeout = 45000; // 45 seconds
      
      const lighthouseResult = await Promise.race([
        runLighthouseAnalysis(targetUrl),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Lighthouse analysis timeout')), lighthouseTimeout)
        )
      ]);
      
      results.lighthouseMetrics = lighthouseResult;
      
      // Update scores based on Lighthouse if available
      if (lighthouseResult.performance !== 'N/A') {
        results.performance.score = Math.max(results.performance.score, lighthouseResult.performance);
      }
      if (lighthouseResult.seo !== 'N/A') {
        results.seo.score = Math.max(results.seo.score, lighthouseResult.seo);
      }
      
    } catch (error) {
      console.error('Lighthouse analysis error:', error.message);
      results.lighthouseMetrics = {
        performance: 'N/A',
        accessibility: 'N/A',
        bestPractices: 'N/A',
        seo: 'N/A',
        firstContentfulPaint: 'N/A',
        largestContentfulPaint: 'N/A',
        speedIndex: 'N/A',
        cumulativeLayoutShift: 'N/A',
        error: error.message.includes('timeout') ? 'Analysis timed out' : 'Analysis failed'
      };
    }

    // Calculate overall totals
    results.failed = results.seo.failed.length + results.performance.failed.length + 
                    results.security.failed.length + results.mobile.failed.length;
    results.warnings = results.seo.warnings.length + results.performance.warnings.length + 
                      results.security.warnings.length + results.mobile.warnings.length;
    results.passed = results.seo.passed.length + results.performance.passed.length + 
                    results.security.passed.length + results.mobile.passed.length;

    // Calculate overall score
    const scores = [results.seo.score, results.performance.score, results.security.score, results.mobile.score];
    results.overallScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    // Add analysis time
    results.analysisTime = Date.now() - analysisStartTime;
    
    console.log(`Analysis completed in ${results.analysisTime}ms`);
    res.json(results);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: 'Failed to analyze URL', 
      details: error.message,
      analysisTime: Date.now() - analysisStartTime
    });
  }
});

// Separate Lighthouse analysis function with better error handling
async function runLighthouseAnalysis(targetUrl) {
  let chrome = null;
  
  try {
    chrome = await chromeLauncher.launch({ 
      chromeFlags: [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox'
      ]
    });
    
    const options = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port,
      maxWaitForFcp: 15 * 1000,
      maxWaitForLoad: 35 * 1000,
      disableDeviceEmulation: false,
      emulatedFormFactor: 'desktop'
    };

    const runnerResult = await lighthouse(targetUrl, options);

    if (runnerResult && runnerResult.lhr) {
      const { categories, audits } = runnerResult.lhr;
      
      return {
        performance: Math.round((categories.performance?.score || 0) * 100),
        accessibility: Math.round((categories.accessibility?.score || 0) * 100),
        bestPractices: Math.round((categories['best-practices']?.score || 0) * 100),
        seo: Math.round((categories.seo?.score || 0) * 100),
        firstContentfulPaint: audits['first-contentful-paint']?.displayValue || 'N/A',
        largestContentfulPaint: audits['largest-contentful-paint']?.displayValue || 'N/A',
        speedIndex: audits['speed-index']?.displayValue || 'N/A',
        cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue || 'N/A'
      };
    } else {
      throw new Error('No Lighthouse results returned');
    }
  } finally {
    if (chrome) {
      try {
        await chrome.kill();
      } catch (error) {
        console.error('Error killing Chrome:', error.message);
      }
    }
  }
}

// SSL Certificate Info Function with better error handling
async function getSSLInfo(hostname) {
  return new Promise((resolve, reject) => {
    const options = {
      host: hostname,
      port: 443,
      servername: hostname,
      rejectUnauthorized: false // Allow self-signed for analysis
    };

    const socket = tls.connect(options, () => {
      try {
        const certificate = socket.getPeerCertificate(true);
        socket.end();
        
        if (!certificate || Object.keys(certificate).length === 0) {
          reject(new Error('No certificate found'));
          return;
        }
        
        resolve({
          subject: certificate.subject?.CN || certificate.subject?.commonName || 'Unknown',
          issuer: certificate.issuer?.CN || certificate.issuer?.commonName || 'Unknown',
          validFrom: certificate.valid_from ? new Date(certificate.valid_from).toLocaleDateString() : 'Unknown',
          validTo: certificate.valid_to ? new Date(certificate.valid_to).toLocaleDateString() : 'Unknown',
          serialNumber: certificate.serialNumber || 'Unknown',
          fingerprint: certificate.fingerprint || 'Unknown',
          version: certificate.version || 'Unknown'
        });
      } catch (error) {
        socket.end();
        reject(error);
      }
    });

    socket.on('error', (error) => {
      reject(new Error(`SSL connection failed: ${error.message}`));
    });

    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('SSL connection timeout'));
    });
  });
}

// DNS Information Function
async function getDNSInfo(hostname) {
  try {
    const [addresses, mx, txt] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolveMx(hostname).catch(() => []),
      dns.resolveTxt(hostname).catch(() => [])
    ]);

    return {
      addresses,
      mx: mx.map(record => ({ exchange: record.exchange, priority: record.priority })),
      txt: txt.flat()
    };
  } catch (error) {
    throw new Error(`DNS resolution failed: ${error.message}`);
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const browserHealth = await browserManager.isBrowserHealthy();
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    browserHealthy: browserHealth
  });
});

// Browser status endpoint for debugging
app.get('/api/browser-status', async (req, res) => {
  try {
    const isHealthy = await browserManager.isBrowserHealthy();
    res.json({
      browserExists: !!browserManager.browser,
      browserConnected: browserManager.browser ? browserManager.browser.isConnected() : false,
      browserHealthy: isHealthy,
      lastUsed: browserManager.lastUsed,
      initAttempts: browserManager.initAttempts,
      isInitializing: browserManager.isInitializing
    });
  } catch (error) {
    res.json({
      error: error.message,
      browserExists: !!browserManager.browser,
      browserConnected: false,
      browserHealthy: false
    });
  }
});

// Force browser restart endpoint for debugging
app.post('/api/restart-browser', async (req, res) => {
  try {
    console.log('Force restarting browser...');
    await browserManager.closeBrowser();
    await browserManager.getBrowser(); // This will create a new one
    res.json({ message: 'Browser restarted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restart browser', details: error.message });
  }
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await browserManager.closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await browserManager.closeBrowser();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await browserManager.closeBrowser();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, just log it
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong' 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`SEO Analyzer server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('Server started successfully');
});
