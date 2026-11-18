/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: MIT-0
 */

import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'

// Largest HTML body accepted, in bytes. Lambda's synchronous payload limit is 6 MB (event JSON included).
const MAX_HTML_BYTES = 4 * 1024 * 1024

// Time left for Chromium to render, below the function timeout (25 s) and API Gateway's 29 s limit.
const RENDER_TIMEOUT_MS = 20000

// Inline content always loads. The only network requests allowed are Google Fonts over https,
// which main-api invoice templates @import; every other network, file or scheme request is aborted.
const ALLOWED_URL_PREFIXES = ['data:', 'about:']
const ALLOWED_FONT_HOSTS = {
  'fonts.googleapis.com': 'stylesheet',
  'fonts.gstatic.com': 'font',
}

// Redirects reach this check again as new requests, so a redirect to another host is aborted too.
function isAllowedRequest(request) {
  const url = request.url()
  if (ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return { allowed: true, external: false }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false }
  }
  const allowedResourceType = Object.hasOwn(ALLOWED_FONT_HOSTS, parsed.hostname) ? ALLOWED_FONT_HOSTS[parsed.hostname] : null
  const allowed =
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    request.method() === 'GET' &&
    allowedResourceType !== null &&
    request.resourceType() === allowedResourceType
  return { allowed, external: allowed }
}

// Viewport chrome-aws-lambda used as its default, kept so page layout does not change.
const VIEWPORT = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
}

// Request header that picks the page sizing; values other than those in PDF_OPTIONS_BY_PAGE_SIZE get a 400.
const PAGE_SIZE_HEADER = 'x-pdf-page-size'

const PDF_OPTIONS_BY_PAGE_SIZE = {
  // No header: callers (main-api invoices) depend on these exact options for the PDF layout.
  default: {
    format: 'a4',
    printBackground: true,
    scale: 1 / 0.75,
  },
  // The HTML's CSS @page rules decide size, orientation, margins and margin boxes (page x of y).
  // format only applies when the HTML declares no @page size (puppeteer would otherwise use Letter).
  css: {
    format: 'a4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
  },
}

chromium.setGraphicsMode = false

function errorResponse(statusCode, errorCode, message, requestId) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    isBase64Encoded: false,
    body: JSON.stringify({ errorCode, message, requestId }),
  }
}

function readPageSize(event) {
  const headers = event?.headers ?? {}
  const name = Object.keys(headers).find((key) => key.toLowerCase() === PAGE_SIZE_HEADER)
  if (name === undefined) {
    return { pageSize: 'default' }
  }
  const value = String(headers[name]).trim().toLowerCase()
  if (value === 'default' || !Object.hasOwn(PDF_OPTIONS_BY_PAGE_SIZE, value)) {
    return { error: 'INVALID_PAGE_SIZE' }
  }
  return { pageSize: value }
}

function readHtml(event) {
  if (typeof event?.body !== 'string' || event.body.length === 0) {
    return { error: 'HTML_REQUIRED' }
  }
  const html = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_HTML_BYTES) {
    return { error: 'HTML_TOO_LARGE', bytes }
  }
  return { html, bytes }
}

async function renderPdf(html, pdfOptions) {
  let browser = null
  let blockedRequests = 0
  let fontRequests = 0
  try {
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: VIEWPORT,
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(RENDER_TIMEOUT_MS)
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const { allowed, external } = isAllowedRequest(request)
      if (allowed) {
        if (external) {
          fontRequests += 1
        }
        request.continue()
      } else {
        blockedRequests += 1
        request.abort('blockedbyclient')
      }
    })
    await page.setContent(html)
    const pdf = await page.pdf(pdfOptions)
    return { pdf: Buffer.from(pdf), blockedRequests, fontRequests }
  } finally {
    if (browser !== null) {
      await browser.close()
    }
  }
}

export const handler = async (event, context) => {
  const requestId = context?.awsRequestId
  const started = Date.now()

  const { pageSize, error: pageSizeError } = readPageSize(event)
  if (pageSizeError) {
    console.warn(JSON.stringify({ requestId, status: 400, errorCode: pageSizeError }))
    return errorResponse(400, pageSizeError, 'X-Pdf-Page-Size must be "css" or absent.', requestId)
  }

  const input = readHtml(event)
  if (input.error === 'HTML_REQUIRED') {
    console.warn(JSON.stringify({ requestId, status: 400, errorCode: input.error }))
    return errorResponse(400, input.error, 'Request body must be a non-empty HTML string.', requestId)
  }
  if (input.error === 'HTML_TOO_LARGE') {
    console.warn(JSON.stringify({ requestId, status: 413, errorCode: input.error, htmlBytes: input.bytes }))
    return errorResponse(413, input.error, `HTML body exceeds ${MAX_HTML_BYTES} bytes.`, requestId)
  }

  try {
    const { pdf, blockedRequests, fontRequests } = await renderPdf(input.html, PDF_OPTIONS_BY_PAGE_SIZE[pageSize])
    console.info(JSON.stringify({
      requestId,
      status: 200,
      pageSize,
      htmlBytes: input.bytes,
      pdfBytes: pdf.length,
      blockedRequests,
      fontRequests,
      durationMs: Date.now() - started,
    }))
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Content-type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="foo.pdf"',
      },
      isBase64Encoded: true,
      body: pdf.toString('base64'),
    }
  } catch (error) {
    // The error message comes from Chromium/puppeteer, never from the HTML body.
    console.error(JSON.stringify({
      requestId,
      status: 500,
      errorCode: 'PDF_RENDER_FAILED',
      htmlBytes: input.bytes,
      durationMs: Date.now() - started,
      error: error?.name,
      errorMessage: error?.message,
    }))
    return errorResponse(500, 'PDF_RENDER_FAILED', 'Rendering the PDF failed.', requestId)
  }
}
