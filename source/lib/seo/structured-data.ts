/** Deterministic checks of captured JSON-LD, not a rich-result eligibility guarantee. */
export type SchemaFinding = {
  code: string; path: string; severity: "ERROR" | "WARNING" | "INFO";
  observed: string; expected: string;
};
/** Entity facts other checks (GEO readiness, the workbench) read without re-parsing JSON-LD. Version 2 and later. */
export type StructuredDataSignals = {
  /** An Article-type node names an author (text or an object with a name). */
  author: boolean; datePublished: boolean; dateModified: boolean;
  /** An Organization or LocalBusiness node with a name. */
  organization: boolean;
  product: boolean; reviews: boolean; faq: boolean;
};
export type StructuredDataReport = {
  /** COMPLETE covers only the supported captured checks, never all Schema.org validation. */
  version: 1 | 2; coverage: "COMPLETE" | "PARTIAL"; truncated: boolean;
  jsonLdBlocks: number; parsedBlocks: number; otherMarkup: boolean;
  entities: { path: string; types: string[]; name: string | null }[];
  findings: SchemaFinding[]; limitations: string[];
  /** Present from version 2. */
  signals?: StructuredDataSignals;
};
/** Report versions this code can read. Version 1 reports (earlier crawls) have no signals and fewer checks. */
export const STRUCTURED_DATA_VERSIONS: readonly number[] = [1, 2];
export function isStructuredDataReport(value: unknown): value is StructuredDataReport {
  return !!value && typeof value === "object" && STRUCTURED_DATA_VERSIONS.includes((value as { version?: unknown }).version as number)
    && Array.isArray((value as { findings?: unknown }).findings) && Array.isArray((value as { entities?: unknown }).entities);
}
export const STRUCTURED_DATA_LIMITS = {
  htmlCharacters: 4 * 1024 * 1024, blockBytes: 64 * 1024, totalBytes: 256 * 1024,
  blocks: 20, nodes: 200, depth: 20, findings: 60, entities: 40,
} as const;
type Obj = Record<string, unknown>;
type Context = "SCHEMA" | "MISSING" | "UNSUPPORTED";
const isObject = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
function preview(value: unknown): string {
  if (value === undefined) return "Not present";
  if (typeof value === "string") return value.slice(0, 400);
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array (${value.length} items)`;
  if (isObject(value)) return `Object (${Object.keys(value).slice(0, 8).join(", ")})`.slice(0, 400);
  return String(value).slice(0, 400);
}
function schemaContext(value: unknown, inherited: Context): Context {
  if (value === undefined) return inherited;
  if (typeof value === "string") return /^https?:\/\/schema\.org\/?$/i.test(value) ? "SCHEMA" : "UNSUPPORTED";
  // Term aliases and remote contexts need JSON-LD expansion; never guess their meaning.
  if (isObject(value) && Object.keys(value).length === 1 && typeof value["@vocab"] === "string") return schemaContext(value["@vocab"], "MISSING");
  if (Array.isArray(value) && value.length === 1) return schemaContext(value[0], "MISSING");
  return value === null ? "MISSING" : "UNSUPPORTED";
}
function simpleType(value: string): string {
  return value.replace(/^https?:\/\/schema\.org\//i, "");
}
function reference(value: unknown): string | null {
  return nonempty(value) ? value : isObject(value) && nonempty(value["@id"]) ? value["@id"] : null;
}
function httpUrl(value: string, base: string): URL | null {
  try { const url = new URL(value, base); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch { return null; }
}
function normalizeTitle(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
/** A finite number, or a plain numeric string ("4.5"), else null. */
function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}
/** The name of a Person/Organization reference: text, an object's name, or the first of an array. */
function personName(value: unknown): string | null {
  if (nonempty(value)) return value.trim();
  if (isObject(value) && nonempty(value.name)) return value.name.trim();
  if (Array.isArray(value)) for (const item of value.slice(0, 5)) { const name = personName(item); if (name) return name; }
  return null;
}
/** Organization types whose own reviews of themselves Google treats as self-serving. */
const BUSINESS_TYPES = new Set(["Organization", "LocalBusiness", "Corporation", "OnlineBusiness", "OnlineStore", "Store", "Restaurant", "FoodEstablishment",
  "ProfessionalService", "MedicalBusiness", "Dentist", "LegalService", "FinancialService", "HomeAndConstructionBusiness", "AutomotiveBusiness",
  "LodgingBusiness", "Hotel", "HealthAndBeautyBusiness", "EducationalOrganization", "SportsOrganization", "NGO", "TravelAgency", "RealEstateAgent"]);
const AVAILABILITY = new Set(["InStock", "OutOfStock", "PreOrder", "PreSale", "BackOrder", "Discontinued", "LimitedAvailability", "OnlineOnly", "InStoreOnly", "SoldOut", "MadeToOrder", "Reserved"]);
const GENERIC_REVIEWER = /^(?:admin|administrator|staff|team|customer|guest|user|anonymous|匿名(?:用户)?|管理员|客服|顾客|买家)$/i;
function validDate(value: string): boolean {
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/);
  if (!date || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`);
  return day.getUTCFullYear() === Number(date[1]) && day.getUTCMonth() + 1 === Number(date[2]) && day.getUTCDate() === Number(date[3]);
}

/** Skip comments and inert/raw-text containers without modifying script source. */
function* capturedScripts(source: string, onTag: (tag: string) => void): Generator<{ attributes: string; body: string }> {
  const tags = /<!--|<\/?[a-z][a-z0-9:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let templates = 0;
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    if (tag[0] === "<!--") {
      const end = source.indexOf("-->", tags.lastIndex);
      tags.lastIndex = end < 0 ? source.length : end + 3;
      continue;
    }
    const name = /^<\/?([a-z][a-z0-9:-]*)/i.exec(tag[0])![1].toLowerCase();
    const closing = tag[0].startsWith("</");
    if (name === "template") { templates = Math.max(0, templates + (closing ? -1 : 1)); continue; }
    if (!closing && !templates) onTag(tag[0]);
    if (closing || !["script", "textarea", "title", "style", "xmp", "iframe", "noembed", "noframes", "noscript"].includes(name)) continue;
    const endPattern = new RegExp(`</${name}\\s*>`, "gi");
    endPattern.lastIndex = tags.lastIndex;
    const end = endPattern.exec(source);
    // HTML raw-text elements may end at EOF; retain their actual captured contents.
    if (!end) { if (name === "script" && !templates) yield { attributes: tag[0].slice(7, -1), body: source.slice(tags.lastIndex) }; tags.lastIndex = source.length; continue; }
    if (name === "script" && !templates) yield { attributes: tag[0].slice(7, -1), body: source.slice(tags.lastIndex, end.index) };
    tags.lastIndex = endPattern.lastIndex;
  }
}

export function analyzeStructuredData(html: string, page: { url: string; title?: string | null }): StructuredDataReport {
  const report: StructuredDataReport = { version: 2, coverage: "COMPLETE", truncated: false, jsonLdBlocks: 0, parsedBlocks: 0,
    otherMarkup: false, entities: [], findings: [], limitations: ["Captured inline JSON-LD only; JavaScript-rendered markup, remote contexts and microdata/RDFa are not validated.",
      "Field checks cover selected common types, not all Schema.org or Google requirements. Facts and rich-result eligibility require review."],
    signals: { author: false, datePublished: false, dateModified: false, organization: false, product: false, reviews: false, faq: false } };
  const signals = report.signals!;
  // Names of the site's own organization, brand or website, and every review author, compared after all blocks are read.
  const ownNames = new Set<string>();
  const reviewAuthors: { path: string; name: string }[] = [];
  const add = (code: string, path: string, severity: SchemaFinding["severity"], observed: unknown, expected: string) => {
    if (report.findings.length >= STRUCTURED_DATA_LIMITS.findings) { report.truncated = true; report.coverage = "PARTIAL"; return; }
    report.findings.push({ code, path: path.slice(0, 240), severity, observed: preview(observed), expected: expected.slice(0, 600) });
  };
  const limit = (path: string, observed: string) => { report.truncated = true; report.coverage = "PARTIAL"; add("LIMIT_REACHED", path, "INFO", observed, "This is a partial check. Review the omitted markup separately."); };
  if (html.length > STRUCTURED_DATA_LIMITS.htmlCharacters) limit("html", "HTML character limit reached");
  const source = html.slice(0, STRUCTURED_DATA_LIMITS.htmlCharacters);
  let bytes = 0; let nodes = 0;
  const checkRating = (rating: unknown, path: string, aggregate: boolean) => {
    if (!isObject(rating)) { add("RATING_REVIEW", path, "WARNING", rating, aggregate ? "Use an AggregateRating object with ratingValue and ratingCount or reviewCount." : "Use a Rating object with ratingValue."); return; }
    if (nonempty(rating["@id"]) && rating.ratingValue === undefined) return;
    const value = numeric(rating.ratingValue);
    const best = rating.bestRating === undefined ? 5 : numeric(rating.bestRating);
    const worst = rating.worstRating === undefined ? 1 : numeric(rating.worstRating);
    if (value === null) add("RATING_REVIEW", `${path}.ratingValue`, "WARNING", rating.ratingValue, "Review snippets need a numeric ratingValue, such as 4.5 (no text or % sign).");
    else if (best !== null && worst !== null && (value > best || value < worst)) add("RATING_REVIEW", `${path}.ratingValue`, "WARNING", rating.ratingValue, `The rating must lie between worstRating (${worst}) and bestRating (${best}); the defaults are 1 and 5.`);
    if (!aggregate) return;
    const count = numeric(rating.ratingCount) ?? numeric(rating.reviewCount);
    if (count === null) add("RATING_REVIEW", `${path}.ratingCount`, "WARNING", rating.ratingCount ?? rating.reviewCount, "AggregateRating needs ratingCount or reviewCount with the real number of ratings.");
    else if (count <= 0) add("RATING_REVIEW", `${path}.ratingCount`, "WARNING", count, "A rating count of zero describes no ratings. Remove the AggregateRating until real ratings exist.");
  };
  const checkReviews = (node: Obj, path: string) => {
    const reviews = Array.isArray(node.review) ? node.review : isObject(node.review) ? [node.review] : [];
    if (reviews.length > 10) limit(`${path}.review`, "Review checks limited to 10 items");
    reviews.slice(0, 10).forEach((review: unknown, index: number) => {
      const reviewPath = `${path}.review[${index}]`;
      if (!isObject(review)) { add("RATING_REVIEW", reviewPath, "WARNING", review, "Use Review objects with an author and a reviewRating."); return; }
      if (nonempty(review["@id"]) && review.author === undefined) return;
      const author = personName(review.author);
      if (!author) add("REVIEW_AUTHOR_MISSING", `${reviewPath}.author`, "WARNING", review.author, "Each review needs the reviewer's displayed name as a Person or Organization. Never invent reviewer names.");
      else {
        reviewAuthors.push({ path: `${reviewPath}.author`, name: author });
        if (GENERIC_REVIEWER.test(author)) add("REVIEW_AUTHOR_GENERIC", `${reviewPath}.author`, "INFO", author, "Use the reviewer's name as shown on the page, not a placeholder such as Admin or Customer.");
      }
      if (review.reviewRating === undefined) add("RATING_REVIEW", `${reviewPath}.reviewRating`, "INFO", undefined, "A review snippet for this review needs reviewRating with a ratingValue.");
      else checkRating(review.reviewRating, `${reviewPath}.reviewRating`, false);
    });
  };
  const inspect = (node: Obj, path: string, context: Context, root: boolean) => {
    const rawTypes = node["@type"];
    if (rawTypes !== undefined && !(nonempty(rawTypes) || Array.isArray(rawTypes) && rawTypes.every(nonempty))) {
      add("TYPE_INVALID", `${path}.@type`, "ERROR", rawTypes, "@type must be a nonempty string or an array of nonempty strings."); return;
    }
    const types = (Array.isArray(rawTypes) ? rawTypes : nonempty(rawTypes) ? [rawTypes] : []).map(v => simpleType(v as string));
    if (!types.length) {
      if (root && !Object.hasOwn(node, "@graph") && !Object.hasOwn(node, "@id")) add("TYPE_MISSING", path, "INFO", "No @type", "Review which entity this node describes; graph containers and references need not declare @type.");
      return;
    }
    if (report.entities.length < STRUCTURED_DATA_LIMITS.entities) report.entities.push({ path: path.slice(0, 240), types: types.slice(0, 8).map(t => t.slice(0, 100)), name: nonempty(node.name) ? node.name.slice(0, 300) : nonempty(node.headline) ? node.headline.slice(0, 300) : null });
    else if (!report.truncated) limit(path, "Entity summary limit reached");
    if (context !== "SCHEMA") {
      report.coverage = "PARTIAL";
      add(context === "MISSING" ? "CONTEXT_MISSING" : "CONTEXT_UNSUPPORTED", `${path}.@context`, "INFO", context, "The vocabulary cannot be fully resolved locally. Review the JSON-LD context before interpreting fields.");
      // A full @type IRI does not expand bare property names without @context.
      return;
    }
    const has = (key: string) => node[key] !== undefined && node[key] !== null && (!Array.isArray(node[key]) || (node[key] as unknown[]).length > 0) && (typeof node[key] !== "string" || !!(node[key] as string).trim());
    const text = (key: string, recommended = false) => {
      if (has(key) && !nonempty(node[key])) add("FIELD_TYPE_INVALID", `${path}.${key}`, "WARNING", node[key], "Review the field type; these checks expect nonempty text and do not expand JSON-LD value objects.");
      else if (!has(key) && recommended) add("FIELD_RECOMMENDED", `${path}.${key}`, "INFO", node[key], "Recommended when truthful and applicable; absence alone is not a general SEO error.");
    };
    const urlField = (key: string) => {
      if (!has(key)) return;
      const value = reference(node[key]);
      if (!value || !httpUrl(value, page.url)) add("URL_REVIEW", `${path}.${key}`, "WARNING", node[key], "Review the URL or entity reference. This check supports HTTP(S) URLs and @id references.");
    };
    for (const key of ["datePublished", "dateModified"]) if (has(key) && (!nonempty(node[key]) || !validDate(node[key] as string))) add("DATE_REVIEW", `${path}.${key}`, "WARNING", node[key], "Use a real ISO 8601 date or a timezone-qualified datetime matching the visible publication or update date.");
    const article = types.some(t => ["Article", "BlogPosting", "NewsArticle"].includes(t));
    const organization = types.some(t => ["Organization", "LocalBusiness"].includes(t));
    const business = types.some(t => BUSINESS_TYPES.has(t));
    const product = types.includes("Product");
    if (business || types.includes("WebSite") || types.includes("Brand")) {
      for (const key of ["name", "alternateName", "legalName"]) {
        const names = Array.isArray(node[key]) ? (node[key] as unknown[]) : [node[key]];
        for (const name of names.slice(0, 5)) if (nonempty(name)) ownNames.add(normalizeTitle(name));
      }
    }
    if (organization && nonempty(node.name)) signals.organization = true;
    if (article) {
      if (personName(node.author)) signals.author = true;
      if (nonempty(node.datePublished) && validDate(node.datePublished)) signals.datePublished = true;
      if (nonempty(node.dateModified) && validDate(node.dateModified)) signals.dateModified = true;
    }
    if (types.includes("FAQPage")) {
      signals.faq = true;
      add("FAQ_RICH_RESULT_RETIRED", path, "INFO", "FAQPage", "Google stopped showing FAQ rich results for all sites in May 2026. Keep the markup only if the questions and answers are visible on the page; expect no FAQ rich result in Google Search.");
    }
    if (types.includes("HowTo")) add("HOWTO_RICH_RESULT_RETIRED", path, "INFO", "HowTo", "Google no longer shows HowTo rich results (retired in 2023). The markup is harmless but brings no rich result in Google Search.");
    const ratingOwner = has("aggregateRating") || has("review");
    if (ratingOwner) {
      signals.reviews = true;
      if (has("aggregateRating")) checkRating(node.aggregateRating, `${path}.aggregateRating`, true);
      if (has("review")) checkReviews(node, path);
      if (business && !product) add("SELF_SERVING_REVIEW", path, "WARNING", "Reviews or ratings on " + types.join(", "), "When this page belongs to the business being reviewed, Google treats ratings it publishes about itself as self-serving and shows no review snippet. Mark up reviews of products or services instead, and only genuine customer reviews.");
    }
    if (article) {
      text("headline", true);
      for (const key of ["author", "image", "datePublished"]) if (!has(key)) add("FIELD_RECOMMENDED", `${path}.${key}`, "INFO", node[key], "Article recommendation only. Add accurate visible information when available; never invent an author, date or image.");
      const title = normalizeTitle(page.title ?? ""); const headline = nonempty(node.headline) ? normalizeTitle(node.headline) : "";
      if (title && headline && !title.includes(headline) && !headline.includes(title)) add("PAGE_TITLE_DIFFERENCE", `${path}.headline`, "INFO", node.headline, `Review against captured page title: ${(page.title ?? "").slice(0, 300)}. Different wording is not automatically an error.`);
      if (has("mainEntityOfPage")) {
        const value = reference(node.mainEntityOfPage); const target = value ? httpUrl(value, page.url) : null;
        const actual = httpUrl(page.url, page.url);
        if (target && actual && `${target.origin}${target.pathname}${target.search}` !== `${actual.origin}${actual.pathname}${actual.search}`) add("PAGE_URL_DIFFERENCE", `${path}.mainEntityOfPage`, "INFO", value, "Review against the captured URL and canonical URL; this may be intentional.");
        else if (!target) urlField("mainEntityOfPage");
      }
    }
    if (organization) { text("name", true); urlField("url"); }
    if (product) {
      text("name");
      if (!has("name")) add("PRODUCT_SNIPPET_ELIGIBILITY", `${path}.name`, "WARNING", node.name, "Google Product snippets require a name. This is a feature-specific eligibility check, not a general indexing requirement.");
      if (!["offers", "review", "aggregateRating"].some(has)) add("PRODUCT_SNIPPET_ELIGIBILITY", path, "WARNING", "No offers, review or aggregateRating", "Product snippets require at least one of these properties. Do not fabricate offers or reviews to satisfy markup.");
      if (has("offers") && !(isObject(node.offers) || Array.isArray(node.offers) && (node.offers as unknown[]).every(isObject))) add("FIELD_TYPE_INVALID", `${path}.offers`, "WARNING", node.offers, "Review Offer or AggregateOffer objects; this check does not expand remote entity references.");
      const offers = (Array.isArray(node.offers) ? node.offers : isObject(node.offers) ? [node.offers] : []).slice(0, 10);
      if (Array.isArray(node.offers) && node.offers.length > 10) limit(`${path}.offers`, "Offer checks limited to 10 items");
      offers.forEach((offer: unknown, index: number) => {
        if (!isObject(offer)) return;
        const offerPath = `${path}.offers[${index}]`;
        if (schemaContext(offer["@context"], context) !== "SCHEMA") { report.coverage = "PARTIAL"; add("CONTEXT_UNSUPPORTED", `${offerPath}.@context`, "INFO", offer["@context"], "Offer fields cannot be interpreted without expanding their context."); return; }
        if (nonempty(offer["@id"])) { report.coverage = "PARTIAL"; add("REFERENCE_NOT_RESOLVED", offerPath, "INFO", offer["@id"], "This lightweight checker does not resolve linked entities. Review the referenced offer and its required properties."); return; }
        const aggregate = offer["@type"] === "AggregateOffer" || offer["@type"] === "https://schema.org/AggregateOffer";
        const price = aggregate ? offer.lowPrice : offer.price ?? (isObject(offer.priceSpecification) ? offer.priceSpecification.price : undefined);
        if (price === undefined) add("PRODUCT_SNIPPET_ELIGIBILITY", `${offerPath}.${aggregate ? "lowPrice" : "price"}`, "WARNING", price, "Offer-based product snippets need a price (or lowPrice for AggregateOffer). Review the applicable Google feature and visible offer.");
        else if (!(typeof price === "number" && Number.isFinite(price) && price >= 0 || typeof price === "string" && /^\d+(?:\.\d+)?$/.test(price))) add("FIELD_TYPE_INVALID", `${offerPath}.price`, "WARNING", price, "Review the price format. Use a nonnegative number without a currency symbol.");
        const currency = offer.priceCurrency ?? (isObject(offer.priceSpecification) ? offer.priceSpecification.priceCurrency : undefined);
        if (currency === undefined) add("FIELD_RECOMMENDED", `${offerPath}.priceCurrency`, "INFO", currency, "Currency is recommended for Product snippets and required for merchant listings. Use the actual three-letter currency code.");
        else if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) add("FIELD_TYPE_INVALID", `${offerPath}.priceCurrency`, "WARNING", currency, "Use a valid three-letter ISO 4217 currency code; this check validates its format only.");
        if (offer.availability !== undefined && !(nonempty(offer.availability) && AVAILABILITY.has(simpleType(offer.availability))))
          add("FIELD_TYPE_INVALID", `${offerPath}.availability`, "WARNING", offer.availability, "Use a schema.org ItemAvailability value such as https://schema.org/InStock or OutOfStock that matches the page.");
      });
      signals.product = true;
      if (offers.length) {
        const offerObjects = offers.filter(isObject);
        // Offer fields of a referenced (@id) offer are unknown here, so only product fields are listed then.
        const offersKnown = offerObjects.length === offers.length && offerObjects.every(offer => !nonempty(offer["@id"]));
        const missing = [
          !has("image") && "image",
          !has("brand") && "brand",
          !["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn", "isbn", "sku"].some(has) && "gtin / mpn / sku",
          offersKnown && !offerObjects.some(offer => offer.availability !== undefined) && "offers.availability",
          offersKnown && !offerObjects.some(offer => offer.shippingDetails !== undefined) && "offers.shippingDetails",
          offersKnown && !(has("hasMerchantReturnPolicy") || offerObjects.some(offer => offer.hasMerchantReturnPolicy !== undefined)) && "hasMerchantReturnPolicy",
        ].filter((field): field is string => !!field);
        if (missing.length) add("MERCHANT_FIELDS_RECOMMENDED", path, "INFO", missing.join(", "), "Merchant listings in Google Shopping surfaces use these fields when they are true for the product. Shipping and return policies can also be set in Merchant Center. Add only real values.");
      }
    }
    if (types.includes("BreadcrumbList")) {
      const items = node.itemListElement;
      if (!Array.isArray(items) || items.length < 2) add("BREADCRUMB_ELIGIBILITY", `${path}.itemListElement`, "WARNING", items, "Google breadcrumb rich results require at least two ListItems. A single item is not a general SEO failure.");
      if (Array.isArray(items)) {
        const positions = new Set<number>();
        items.slice(0, STRUCTURED_DATA_LIMITS.nodes).forEach((item, i) => {
          const itemPath = `${path}.itemListElement[${i}]`;
          if (!isObject(item)) { add("BREADCRUMB_ELIGIBILITY", itemPath, "WARNING", item, "Review the ListItem object."); return; }
          if (!Number.isInteger(item.position) || (item.position as number) < 1 || positions.has(item.position as number)) add("BREADCRUMB_ELIGIBILITY", `${itemPath}.position`, "WARNING", item.position, "Use positive, unique integer positions for the breadcrumb trail.");
          else positions.add(item.position as number);
          if (!nonempty(item.name) && !(isObject(item.item) && nonempty(item.item.name))) add("BREADCRUMB_ELIGIBILITY", `${itemPath}.name`, "WARNING", item.name, "Provide the visible breadcrumb name, either here or on its item object.");
          if (i < items.length - 1 || item.item !== undefined) {
            const url = reference(item.item);
            if (!url || !httpUrl(url, page.url)) add("BREADCRUMB_ELIGIBILITY", `${itemPath}.item`, "WARNING", item.item, "Provide the breadcrumb destination. The last ListItem may omit item.");
          }
        });
      }
    }
  };
  const observeTag = (tag: string) => {
    const attrs = tag.replace(/^<[^\s/>]+/, "").slice(0, -1);
    for (const attribute of attrs.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      if (["itemscope", "itemtype", "typeof"].includes(attribute[1].toLowerCase())) report.otherMarkup = true;
    }
  };
  for (const script of capturedScripts(source, observeTag)) {
    const attributes = [...script.attributes.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)];
    const type = attributes.find(a => a[1].toLowerCase() === "type");
    if (!type || (type[2] ?? type[3] ?? type[4] ?? "").trim().split(";")[0].toLowerCase() !== "application/ld+json") continue;
    const path = `script[${report.jsonLdBlocks++}]`;
    if (report.jsonLdBlocks > STRUCTURED_DATA_LIMITS.blocks) { limit(path, "JSON-LD block count limit reached"); break; }
    const body = script.body.trim(); const size = new TextEncoder().encode(body).byteLength;
    if (size > STRUCTURED_DATA_LIMITS.blockBytes || bytes + size > STRUCTURED_DATA_LIMITS.totalBytes) { limit(path, "JSON-LD byte limit reached"); continue; }
    bytes += size;
    let root: unknown;
    try { root = JSON.parse(body); } catch { add("JSON_INVALID", path, "ERROR", "JSON cannot be parsed", "Fix JSON syntax before validating fields. Script contents were not executed."); continue; }
    report.parsedBlocks++;
    if (!isObject(root) && !Array.isArray(root)) { add("JSON_ROOT_INVALID", path, "ERROR", root, "A JSON-LD document must be an object or array of node objects."); continue; }
    const stack: { value: unknown; path: string; context: Context; depth: number; root: boolean }[] = [{ value: root, path, context: "MISSING", depth: 0, root: true }];
    while (stack.length) {
      const current = stack.pop()!;
      if (!isObject(current.value) && !Array.isArray(current.value)) {
        if (current.root) add("JSON_ROOT_INVALID", current.path, "ERROR", current.value, "Root arrays and @graph must contain node objects.");
        continue;
      }
      if (++nodes > STRUCTURED_DATA_LIMITS.nodes || current.depth > STRUCTURED_DATA_LIMITS.depth) { limit(current.path, "JSON-LD node or depth limit reached"); break; }
      if (Array.isArray(current.value)) {
        const entries = current.value.slice(0, STRUCTURED_DATA_LIMITS.nodes);
        if (entries.length !== current.value.length) limit(current.path, "Array length limit reached");
        for (let i = entries.length - 1; i >= 0; i--) stack.push({ ...current, value: entries[i], path: `${current.path}[${i}]`, depth: current.depth + 1 });
        continue;
      }
      const node = current.value; const context = schemaContext(node["@context"], current.context);
      inspect(node, current.path, context, current.root);
      const children = Object.entries(node).filter(([key, value]) => key !== "@context" && key !== "@type" && value && typeof value === "object");
      if (children.length > STRUCTURED_DATA_LIMITS.nodes) limit(current.path, "Property count limit reached");
      for (const [key, value] of children.slice(0, STRUCTURED_DATA_LIMITS.nodes).reverse()) stack.push({ value, path: `${current.path}.${key.slice(0, 60)}`, context, depth: current.depth + 1, root: key === "@graph" });
    }
  }
  for (const review of reviewAuthors) {
    if (ownNames.has(normalizeTitle(review.name))) add("REVIEW_SELF_AUTHORED", review.path, "WARNING", review.name, "The reviewer has the same name as this site's organization, brand or website. Google's review snippet guidelines exclude reviews written by the business itself; mark up genuine customer reviews only.");
  }
  if (signals.reviews) add("REVIEW_GUIDELINES", "html", "INFO", "Review or rating markup present", "Ratings must come from real customers and be visible on this page. Do not copy reviews from other sites or mark up incentivized reviews without disclosure; violations can lead to a manual action. This check cannot verify where reviews come from.");
  if (report.otherMarkup) { report.coverage = "PARTIAL"; add("OTHER_MARKUP_NOT_CHECKED", "html", "INFO", "Microdata or RDFa attributes observed", "JSON-LD checks do not validate this markup."); }
  if (!report.jsonLdBlocks) add("NO_JSON_LD", "html", "INFO", "No JSON-LD in the inspected HTML", "Schema is optional. Check the page type and other markup before deciding whether to add it.");
  if (report.truncated && !report.findings.some(f => f.code === "LIMIT_REACHED")) report.findings[report.findings.length - 1] = { code: "LIMIT_REACHED", path: "report", severity: "INFO", observed: "Finding limit reached", expected: "Partial findings; inspect omitted markup separately." };
  return report;
}
