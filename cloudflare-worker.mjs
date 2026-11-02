/**
 * Chocolate Finance path router and reverse proxy.
 *
 * Public:          https://www.chocolatefinance.com
 * Webflow origin:  https://wf.chocolatefinance.com
 * Next.js origin:  https://chocofin.netlify.app
 *
 * IMPORTANT:
 * - Route this Worker only on chocolatefinance.com/* and
 *   www.chocolatefinance.com/*.
 * - Do not route it on either origin subdomain.
 * - Each origin must serve content directly and must not redirect every
 *   request back to the public hostname.
 */

const DEFAULT_PUBLIC_HOST = "www.chocolatefinance.com";
const DEFAULT_APEX_HOST = "chocolatefinance.com";
const DEFAULT_WEBFLOW_HOST = "wf.chocolatefinance.com";
const WEBFLOW_MANAGED_PATHS = new Set(["/robots.txt", "/sitemap.xml"]);

function parseStringArray(value, variableName) {
  if (!value) return [];

  const items = Array.isArray(value) ? value : JSON.parse(value);
  if (!Array.isArray(items)) {
    throw new TypeError(`${variableName} must be a JSON array`);
  }

  return items.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError(
        `Invalid ${variableName} entry: ${JSON.stringify(item)}`,
      );
    }

    return item;
  });
}

function parseRoutePatterns(value) {
  return parseStringArray(value, "NEXT_ROUTES").map((pattern) => {
    if (!pattern || !pattern.startsWith("/")) {
      throw new TypeError(
        `Invalid NEXT_ROUTES entry: ${JSON.stringify(pattern)}`,
      );
    }

    return pattern;
  });
}

function normalizeHostname(value, variableName) {
  if (!value) return "";

  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new TypeError(`${variableName} must be a valid hostname or URL`);
  }

  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      `${variableName} must not include credentials, a port, path, query, or hash`,
    );
  }

  return url.hostname;
}

function normalizePathname(pathname) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

function matchesRoute(pathname, pattern, localePrefixes = []) {
  if (pattern.includes("{locale}")) {
    return localePrefixes.some((locale) =>
      matchesRoute(pathname, pattern.replaceAll("{locale}", locale)),
    );
  }

  const currentPath = normalizePathname(pathname);
  const isPrefix = pattern.endsWith("/*");
  const patternPath = normalizePathname(
    isPrefix ? pattern.slice(0, -2) || "/" : pattern,
  );

  if (!isPrefix) return currentPath === patternPath;
  if (patternPath === "/") return true;

  return (
    currentPath === patternPath || currentPath.startsWith(`${patternPath}/`)
  );
}

function getConfig(env) {
  const publicHost = normalizeHostname(
    env.PUBLIC_HOST || DEFAULT_PUBLIC_HOST,
    "PUBLIC_HOST",
  );
  const apexHost = normalizeHostname(
    env.APEX_HOST || DEFAULT_APEX_HOST,
    "APEX_HOST",
  );
  const webflowHost = normalizeHostname(
    env.WEBFLOW_HOST || env.UPSTREAM_HOST || DEFAULT_WEBFLOW_HOST,
    "WEBFLOW_HOST",
  );
  const nextHost = normalizeHostname(env.NEXT_HOST || "", "NEXT_HOST");
  const nextRoutes = parseRoutePatterns(env.NEXT_ROUTES);
  const localePrefixes = parseStringArray(
    env.LOCALE_PREFIXES,
    "LOCALE_PREFIXES",
  )
    .map((locale) => locale.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((normalizedLocale) => {
      if (normalizedLocale.includes("/")) {
        throw new TypeError(
          `Invalid LOCALE_PREFIXES entry: ${JSON.stringify(normalizedLocale)}`,
        );
      }

      return normalizedLocale;
    });
  const aliases = (env.UPSTREAM_ALIASES || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const previewHosts = new Set(
    parseStringArray(env.PREVIEW_HOSTS, "PREVIEW_HOSTS").map((host) =>
      normalizeHostname(host, "PREVIEW_HOSTS"),
    ),
  );

  return {
    publicHost,
    apexHost,
    webflowHost,
    nextHost,
    nextRoutes,
    localePrefixes,
    previewHosts,
    upstreamHosts: new Set(
      [webflowHost, nextHost, ...aliases].filter(Boolean),
    ),
    publicOrigin: `https://${publicHost}`,
  };
}

function selectUpstreamHost(pathname, config) {
  const normalizedPathname = normalizePathname(pathname);

  // Keep the public crawl-control endpoints on Webflow while the migration is
  // in progress. Webflow remains the source of truth for the combined sitemap.
  if (WEBFLOW_MANAGED_PATHS.has(normalizedPathname)) {
    return config.webflowHost;
  }

  if (
    config.nextHost &&
    config.nextRoutes.some((pattern) =>
      matchesRoute(normalizedPathname, pattern, config.localePrefixes),
    )
  ) {
    return config.nextHost;
  }

  return config.webflowHost;
}

function redirectToCanonicalHost(url, config) {
  if (url.protocol !== "https:" || url.hostname === config.apexHost) {
    const target = new URL(url);
    target.protocol = "https:";
    target.hostname = config.publicHost;
    target.port = "";
    return Response.redirect(target.toString(), 308);
  }

  return null;
}

function rewriteUrl(value, baseUrl, config) {
  if (!value) return value;

  let target;
  try {
    target = new URL(value, baseUrl);
  } catch {
    return replaceHostReferences(value, config);
  }

  if (config.upstreamHosts.has(target.hostname)) {
    target.protocol = "https:";
    target.hostname = config.publicHost;
    target.port = "";
    return target.toString();
  }

  return value;
}

function replaceHostReferences(value, config) {
  let result = value;

  for (const host of config.upstreamHosts) {
    result = result.split(host).join(config.publicHost);
  }

  return result;
}

function sameUrl(left, right) {
  const normalize = (value) => {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  };

  return normalize(left) === normalize(right);
}

function prepareUpstreamRequest(request, requestUrl, config, upstreamHost) {
  const upstreamOrigin = `https://${upstreamHost}`;
  const upstreamUrl = new URL(requestUrl);
  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = upstreamHost;
  upstreamUrl.port = "";

  const headers = new Headers(request.headers);
  headers.set("Host", upstreamHost);
  headers.set("X-Forwarded-Host", config.publicHost);
  headers.set("X-Forwarded-Proto", "https");

  const origin = headers.get("Origin");
  if (origin === config.publicOrigin) {
    headers.set("Origin", upstreamOrigin);
  }

  const referer = headers.get("Referer");
  if (referer?.startsWith(config.publicOrigin)) {
    headers.set(
      "Referer",
      `${upstreamOrigin}${referer.slice(config.publicOrigin.length)}`,
    );
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return {
    upstreamUrl,
    request: new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    }),
  };
}

function rewriteResponseHeaders(response, upstreamUrl, config) {
  const headers = new Headers(response.headers);

  for (const name of [
    "Location",
    "Content-Location",
    "Link",
    "Refresh",
    "Access-Control-Allow-Origin",
  ]) {
    const value = headers.get(name);
    if (value) {
      headers.set(name, replaceHostReferences(value, config));
    }
  }

  const getAll = response.headers.getAll?.bind(response.headers);
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const cookies = getAll
    ? getAll("Set-Cookie")
    : getSetCookie
      ? getSetCookie()
      : response.headers.get("Set-Cookie")
        ? [response.headers.get("Set-Cookie")]
        : [];

  if (cookies.length > 0) {
    headers.delete("Set-Cookie");
    for (const cookie of cookies) {
      headers.append("Set-Cookie", replaceHostReferences(cookie, config));
    }
  }

  return headers;
}

function removeCspDirective(value, directiveName) {
  if (!value) return value;

  return value
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => {
      const [name] = directive.split(/\s+/, 1);
      return name.toLowerCase() !== directiveName.toLowerCase();
    })
    .join("; ");
}

function allowCloudflarePreviewFrame(headers) {
  headers.delete("X-Frame-Options");

  for (const name of [
    "Content-Security-Policy",
    "Content-Security-Policy-Report-Only",
  ]) {
    const value = headers.get(name);
    if (!value) continue;

    const updatedValue = removeCspDirective(value, "frame-ancestors");
    if (updatedValue) {
      headers.set(name, updatedValue);
    } else {
      headers.delete(name);
    }
  }
}

function isRewritableBody(requestUrl, contentType) {
  if (requestUrl.pathname === "/robots.txt") return true;
  if (requestUrl.pathname.endsWith(".xml")) return true;

  return /(?:text\/html|application\/xhtml\+xml|application\/xml|text\/xml|application\/rss\+xml)/i.test(
    contentType,
  );
}

async function proxy(request, env) {
  const config = getConfig(env);
  const requestUrl = new URL(request.url);
  const isPreviewHost = config.previewHosts.has(requestUrl.hostname);

  if (
    ![config.publicHost, config.apexHost].includes(requestUrl.hostname) &&
    !isPreviewHost
  ) {
    return new Response("Host not allowed", { status: 400 });
  }

  // On an explicitly allowed preview hostname, keep navigation and rewritten
  // origin URLs inside preview. Never expose preview pages to search engines.
  const responseConfig = isPreviewHost
    ? {
        ...config,
        publicHost: requestUrl.hostname,
        publicOrigin: requestUrl.origin,
      }
    : config;

  const canonicalRedirect = redirectToCanonicalHost(requestUrl, responseConfig);
  if (canonicalRedirect) return canonicalRedirect;

  const upstreamHost = selectUpstreamHost(requestUrl.pathname, config);

  const { upstreamUrl, request: upstreamRequest } = prepareUpstreamRequest(
    request,
    requestUrl,
    responseConfig,
    upstreamHost,
  );

  const upstreamResponse = await fetch(upstreamRequest);
  const headers = rewriteResponseHeaders(
    upstreamResponse,
    upstreamUrl,
    responseConfig,
  );

  if (isPreviewHost) {
    allowCloudflarePreviewFrame(headers);
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    headers.set("Cache-Control", "private, no-store");
  } else {
    // Both origin hostnames can safely return a blanket X-Robots-Tag to stop
    // direct-origin indexing. Remove only that hostname-level header when the
    // same response is served from the canonical public domain. Intentional
    // page-level <meta name="robots"> directives remain untouched.
    headers.delete("X-Robots-Tag");
  }

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const upstreamLocation = upstreamResponse.headers.get("Location");

    if (upstreamLocation) {
      const publicLocation = rewriteUrl(
        upstreamLocation,
        upstreamUrl,
        responseConfig,
      );
      headers.set("Location", publicLocation);

      // This means the selected origin is forcing its URL back to the exact
      // same public URL. Returning it would create a redirect loop.
      if (sameUrl(publicLocation, requestUrl.toString())) {
        return new Response(
          `Upstream redirect loop: configure ${upstreamHost} to serve content directly without redirecting this URL to the primary domain.`,
          {
            status: 502,
            headers: { "Content-Type": "text/plain; charset=UTF-8" },
          },
        );
      }
    }

    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const contentType = headers.get("Content-Type") || "";
  const shouldRewrite =
    request.method !== "HEAD" &&
    isRewritableBody(requestUrl, contentType);

  if (!shouldRewrite) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const originalBody = await upstreamResponse.text();
  const rewrittenBody = replaceHostReferences(originalBody, responseConfig);

  // Body changed, so upstream byte length/compression/entity validators no
  // longer describe the returned representation.
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("ETag");

  // Preserve the upstream XML content type so Webflow sitemap responses keep
  // the same browser rendering and crawler semantics as the public origin.
  if (requestUrl.pathname === "/robots.txt") {
    headers.set("Content-Type", "text/plain; charset=UTF-8");
  }

  return new Response(rewrittenBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      return await proxy(request, env);
    } catch (error) {
      console.error("Origin proxy failed", error);
      return new Response("Bad Gateway", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }
  },
};

export {
  allowCloudflarePreviewFrame,
  getConfig,
  matchesRoute,
  normalizeHostname,
  proxy,
  removeCspDirective,
  replaceHostReferences,
  rewriteUrl,
  selectUpstreamHost,
};
