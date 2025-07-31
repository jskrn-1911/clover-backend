export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Environment variables validation
  const CLOVER_AUTH_TOKEN = process.env.CLOVER_AUTH_TOKEN;
  const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  
  if (!CLOVER_AUTH_TOKEN || !CLOVER_MERCHANT_ID) {
    return res.status(500).json({ 
      error: 'Server configuration error',
      details: 'Missing Clover credentials'
    });
  }

  try {
    const { amount, coupon, customerData } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount provided' });
    }

    // Coupon validation
    const coupons = [
      { code: 'SAVE10', type: 'percentage', value: 10, active: true },
      { code: 'SAVE20', type: 'percentage', value: 20, active: true },
      { code: 'SAVE50', type: 'percentage', value: 50, active: true }
    ];

    let discountAmount = 0;
    let appliedCoupon = null;
    
    if (coupon) {
      const foundCoupon = coupons.find(c => c.code === coupon && c.active);
      if (foundCoupon) {
        discountAmount = Math.round((amount * foundCoupon.value) / 100);
        appliedCoupon = foundCoupon;
      }
    }

    const finalAmount = Math.max(0, amount - discountAmount);

    // Create Clover hosted checkout session with enhanced retry logic
    const cloverResponse = await createHostedCheckoutSession({
      amount: finalAmount,
      originalAmount: amount,
      discountAmount,
      coupon: appliedCoupon,
      customerData: customerData || {}
    });

    if (!cloverResponse.success) {
      return res.status(cloverResponse.statusCode || 500).json({ 
        error: 'Payment processing failed',
        details: cloverResponse.error,
        retryAfter: cloverResponse.retryAfter
      });
    }

    return res.status(200).json({
      checkoutUrl: cloverResponse.checkoutUrl,
      originalAmount: amount,
      discountAmount,
      finalAmount,
      couponApplied: appliedCoupon?.code || null,
      sessionId: cloverResponse.sessionId
    });

  } catch (error) {
    console.error('Checkout processing error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

// Enhanced function with comprehensive retry and backoff logic
async function createHostedCheckoutSession({ amount, originalAmount, discountAmount, coupon, customerData }) {
  const CLOVER_AUTH_TOKEN = process.env.CLOVER_AUTH_TOKEN;
  const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  
  // Production URL
  const HOSTED_CHECKOUT_URL = 'https://api.clover.com/invoicingcheckoutservice/v1/checkouts';

  try {
    const lineItemName = coupon 
      ? `Order (${coupon.code} applied - $${discountAmount} off)` 
      : 'Order';

    const checkoutPayload = {
      customer: {
        email: customerData.email || 'customer@example.com',
        firstName: customerData.name?.split(' ')[0] || 'Customer',
        lastName: customerData.name?.split(' ').slice(1).join(' ') || 'User'
      },
      shoppingCart: {
        lineItems: [
          {
            name: lineItemName,
            price: amount * 100, // In cents
            unitQty: 1,
            note: coupon ? `Original: $${originalAmount}, Discount: $${discountAmount}` : 'Online order'
          }
        ]
      }
    };

    // Make API request with enhanced retry logic
    const result = await makeRequestWithRetry(HOSTED_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOVER_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Clover-Merchant-Id': CLOVER_MERCHANT_ID,
        // Add additional headers for better tracking
        'User-Agent': 'CloverCheckout/1.0',
        'X-Request-ID': generateRequestId()
      },
      body: JSON.stringify(checkoutPayload)
    });

    return {
      success: true,
      checkoutUrl: result.href,
      sessionId: result.checkoutSessionId
    };

  } catch (error) {
    console.error('Clover Hosted Checkout API error:', error);
    
    // Return structured error response
    if (error.statusCode === 429) {
      return {
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        statusCode: 429,
        retryAfter: error.retryAfter
      };
    }
    
    return {
      success: false,
      error: error.message,
      statusCode: error.statusCode || 500
    };
  }
}

// Enhanced retry function with better rate limit handling
async function makeRequestWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Making API request (attempt ${attempt + 1}/${maxRetries + 1}) at ${new Date().toISOString()}`);
      
      // Add a small delay before each request to respect rate limits
      if (attempt > 0) {
        await sleep(1000); // Always wait 1 second between retries
      }
      
      const response = await fetch(url, options);
      
      // Log response headers for debugging
      console.log(`Response status: ${response.status}`);
      console.log(`Rate limit headers:`, {
        remaining: response.headers.get('X-RateLimit-Remaining'),
        limit: response.headers.get('X-RateLimit-Limit'),
        reset: response.headers.get('X-RateLimit-Reset'),
        tokenLimit: response.headers.get('X-RateLimit-tokenLimit')
      });
      
      // If successful, return the parsed response
      if (response.ok) {
        return await response.json();
      }
      
      // Handle 429 specifically with enhanced backoff
      if (response.status === 429) {
        if (attempt === maxRetries) {
          const error = new Error(`Rate limit exceeded after ${maxRetries + 1} attempts`);
          error.statusCode = 429;
          
          // Extract retry-after from headers
          const retryAfter = response.headers.get('Retry-After') || response.headers.get('X-RateLimit-Reset');
          if (retryAfter) {
            error.retryAfter = retryAfter;
          }
          
          throw error;
        }
        
        // Determine wait time from headers
        const retryAfter = response.headers.get('Retry-After');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');
        let waitTime;
        
        if (retryAfter) {
          // Retry-After can be in seconds or HTTP date format
          if (/^\d+$/.test(retryAfter)) {
            waitTime = parseInt(retryAfter) * 1000; // Convert seconds to milliseconds
          } else {
            const retryDate = new Date(retryAfter);
            waitTime = Math.max(0, retryDate.getTime() - Date.now());
          }
        } else if (rateLimitReset) {
          // X-RateLimit-Reset is typically a Unix timestamp
          const resetTime = parseInt(rateLimitReset) * 1000;
          waitTime = Math.max(0, resetTime - Date.now());
        } else {
          // Use aggressive exponential backoff for 429 errors
          waitTime = baseDelay * Math.pow(3, attempt) + (Math.random() * 2000);
        }
        
        // Cap maximum wait time at 60 seconds
        waitTime = Math.min(waitTime, 60000);
        
        console.log(`Rate limited (429). Waiting ${waitTime}ms before retry (attempt ${attempt + 1})`);
        await sleep(waitTime);
        continue;
      }
      
      // Handle other HTTP errors
      const errorText = await response.text();
      const error = new Error(`HTTP ${response.status}: ${errorText}`);
      error.statusCode = response.status;
      
      // Don't retry on client errors (4xx) except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw error;
      }
      
      // Retry server errors (5xx) with backoff
      if (response.status >= 500) {
        if (attempt === maxRetries) {
          throw error;
        }
        const waitTime = baseDelay * Math.pow(2, attempt);
        console.log(`Server error ${response.status}. Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
        continue;
      }
      
      throw error;
      
    } catch (error) {
      lastError = error;
      
      // Only retry for network errors, not application errors
      if (error.name === 'TypeError' || error.message.includes('fetch') || error.code === 'ECONNRESET') {
        if (attempt === maxRetries) {
          throw error;
        }
        const waitTime = baseDelay * Math.pow(2, attempt);
        console.log(`Network error: ${error.message}. Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
        continue;
      }
      
      // For other errors, don't retry
      throw error;
    }
  }
  
  throw lastError;
}

// Utility function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate unique request ID for tracking
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Optional: Add request queuing to prevent concurrent requests
class RequestQueue {
  constructor(maxConcurrent = 1, minInterval = 1000) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.lastRequestTime = 0;
  }

  async add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { requestFn, resolve, reject } = this.queue.shift();
    this.running++;

    try {
      // Ensure minimum interval between requests
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.minInterval) {
        await sleep(this.minInterval - timeSinceLastRequest);
      }

      this.lastRequestTime = Date.now();
      const result = await requestFn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      // Process next item in queue
      setTimeout(() => this.process(), 100);
    }
  }
}

// Export singleton queue instance
export const cloverRequestQueue = new RequestQueue(1, 1000); // 1 request per second max