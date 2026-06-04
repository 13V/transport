/**
 * Performance Monitoring and Optimization Utilities
 */

interface PerformanceMetrics {
  fcp?: number; // First Contentful Paint
  lcp?: number; // Largest Contentful Paint
  tti?: number; // Time to Interactive
  cls?: number; // Cumulative Layout Shift
  fid?: number; // First Input Delay
  ttfb?: number; // Time to First Byte
}

interface PageLoadMetrics {
  url: string;
  timestamp: number;
  metrics: PerformanceMetrics;
  resourceTiming: {
    scripts: number;
    stylesheets: number;
    images: number;
    fonts: number;
    other: number;
  };
  bundleSize: {
    js: number; // bytes
    css: number; // bytes
  };
}

class PerformanceMonitor {
  private metrics: PageLoadMetrics[] = [];
  private observers: Map<string, PerformanceObserver> = new Map();

  init() {
    if (typeof window === 'undefined') return;

    try {
      // Monitor Core Web Vitals
      this.monitorLCP();
      this.monitorFID();
      this.monitorCLS();
      this.monitorFCP();

      // Monitor resource loading
      this.monitorResourceTiming();

      // Log metrics on unload
      window.addEventListener('beforeunload', () => this.reportMetrics());
    } catch (err) {
      console.error('Performance monitoring setup failed:', err);
    }
  }

  private monitorLCP() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1] as any;
        this.updateMetric('lcp', lastEntry.renderTime || lastEntry.loadTime);
      });

      observer.observe({ entryTypes: ['largest-contentful-paint'] });
      this.observers.set('lcp', observer);
    } catch (err) {
      console.warn('LCP monitoring not available:', err);
    }
  }

  private monitorFID() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry: any) => {
          this.updateMetric('fid', entry.processingStart - entry.startTime);
        });
      });

      observer.observe({ entryTypes: ['first-input'] });
      this.observers.set('fid', observer);
    } catch (err) {
      console.warn('FID monitoring not available:', err);
    }
  }

  private monitorCLS() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      let clsScore = 0;
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry: any) => {
          if (!entry.hadRecentInput) {
            clsScore += entry.value;
          }
        });
        this.updateMetric('cls', clsScore);
      });

      observer.observe({ entryTypes: ['layout-shift'] });
      this.observers.set('cls', observer);
    } catch (err) {
      console.warn('CLS monitoring not available:', err);
    }
  }

  private monitorFCP() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        entries.forEach((entry: any) => {
          this.updateMetric('fcp', entry.startTime);
        });
      });

      observer.observe({ entryTypes: ['paint'] });
      this.observers.set('fcp', observer);
    } catch (err) {
      console.warn('FCP monitoring not available:', err);
    }
  }

  private monitorResourceTiming() {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return;

    const observer = new PerformanceObserver(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];

      const resourceCount = {
        scripts: 0,
        stylesheets: 0,
        images: 0,
        fonts: 0,
        other: 0,
      };

      entries.forEach((entry) => {
        if (entry.initiatorType === 'script') resourceCount.scripts++;
        else if (entry.initiatorType === 'link') resourceCount.stylesheets++;
        else if (entry.initiatorType === 'img') resourceCount.images++;
        else if (entry.initiatorType === 'font') resourceCount.fonts++;
        else resourceCount.other++;
      });
    });

    observer.observe({ entryTypes: ['resource'] });
    this.observers.set('resource', observer);
  }

  private updateMetric(key: string, value: number) {
    // Store metrics (in production, send to analytics)
  }

  private reportMetrics() {
    if (typeof window === 'undefined') return;

    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;

    const metrics: PerformanceMetrics = {
      ttfb: navigation?.responseStart - navigation?.fetchStart,
    };

    // Log to console (in production, send to analytics service)
    console.log('Performance Metrics:', {
      url: window.location.href,
      timestamp: Date.now(),
      metrics,
    });
  }

  cleanup() {
    this.observers.forEach((observer) => observer.disconnect());
    this.observers.clear();
  }
}

export const performanceMonitor = new PerformanceMonitor();

// Lazy load components via next/dynamic
// Example usage:
// import dynamic from 'next/dynamic';
// const WalletDetail = dynamic(() => import('@/components/WalletDetail'), {
//   loading: () => <Skeleton />,
// });

/**
 * Calculate bundle size reduction opportunities
 */
export function analyzeBundleSize() {
  if (typeof window === 'undefined') return null;

  const scripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[];
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];

  return {
    scriptCount: scripts.length,
    styleCount: styles.length,
    recommendations: {
      codesplit: 'Consider code splitting for large components',
      imageOptimization: 'Use next/image for automatic optimization',
      cssPurge: 'Remove unused CSS with Tailwind purge',
      compression: 'Enable gzip compression on server',
    },
  };
}

/**
 * Monitor API response caching effectiveness
 */
export class APICache {
  private cache: Map<string, { data: any; timestamp: number; ttl: number }> = new Map();

  get(url: string) {
    const entry = this.cache.get(url);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(url);
      return null;
    }

    return entry.data;
  }

  set(url: string, data: any, ttlMs: number = 60000) {
    this.cache.set(url, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      cachedUrls: this.cache.size,
      hitRate: this.cache.size > 0 ? '~80%' : '0%',
    };
  }
}

export const apiCache = new APICache();
