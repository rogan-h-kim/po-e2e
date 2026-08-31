import type { Selector } from "../shared/types";

// ---------------------------------------------------------------------------
// Accessibility-first selector engine.
//
// The whole point (Cake's insight): if an element has a proper role + name,
// it is stable to target and survives DOM refactors. We compute an approximate
// ARIA role and accessible name, and only fall back to CSS (with a warning)
// when accessibility info is missing.
// ---------------------------------------------------------------------------

const TESTID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy"];

/** Approximate the ARIA role (explicit role attr wins, else implicit by tag). */
export function computeRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0];

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "button":
      return "button";
    case "a":
      return el.hasAttribute("href") ? "link" : null;
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "img":
      return "img";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "nav":
      return "navigation";
    case "input": {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type))
        return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    default:
      return null;
  }
}

const isInteractive = (role: string | null): boolean =>
  role !== null &&
  [
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "combobox",
    "searchbox",
    "slider",
    "tab",
    "menuitem",
  ].includes(role);

function normalize(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

/** Approximate accessible name computation (a practical subset of accname). */
export function accessibleName(el: Element): string {
  // 1. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (normalize(ariaLabel)) return normalize(ariaLabel);

  // 2. aria-labelledby
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => normalize(el.ownerDocument.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  const tag = el.tagName.toLowerCase();

  // 3. Form controls: associated <label>
  if (["input", "textarea", "select"].includes(tag)) {
    const id = el.getAttribute("id");
    if (id) {
      const forLabel = el.ownerDocument.querySelector(
        `label[for="${CSS.escape(id)}"]`,
      );
      if (normalize(forLabel?.textContent))
        return normalize(forLabel!.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping && normalize(wrapping.textContent))
      return normalize(wrapping.textContent);
    // placeholder as a last-resort name for inputs
    const placeholder = el.getAttribute("placeholder");
    if (normalize(placeholder)) return normalize(placeholder);
  }

  // 4. img alt
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (normalize(alt)) return normalize(alt);
  }

  // 5. Text content for name-from-content roles (button/link/heading/etc.)
  const role = computeRole(el);
  if (
    role &&
    [
      "button",
      "link",
      "heading",
      "tab",
      "menuitem",
      "checkbox",
      "radio",
    ].includes(role)
  ) {
    if (normalize(el.textContent)) return normalize(el.textContent);
  }

  // 6. title
  const title = el.getAttribute("title");
  if (normalize(title)) return normalize(title);

  return "";
}

function getTestId(el: Element): { attr: string; value: string } | null {
  for (const attr of TESTID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return { attr, value };
  }
  return null;
}

/** Build a reasonably-unique CSS selector as a last resort. */
function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/**
 * From a raw clicked element, walk up to the nearest meaningful target
 * (e.g. clicking a <span> inside a <button> should target the button).
 */
export function resolveTarget(el: Element): Element {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 5; depth++) {
    if (getTestId(node)) return node;
    if (isInteractive(computeRole(node))) return node;
    node = node.parentElement;
  }
  return el;
}

/**
 * Generate the best selector for an element, attaching an nth index and/or a
 * warning when the selector is ambiguous or low-accuracy.
 */
export function generateSelector(el: Element): Selector {
  // 1. Test id — explicit and stable.
  const testid = getTestId(el);
  if (testid) {
    return { strategy: "testid", testid: testid.value };
  }

  // 2. Role + accessible name — the accessibility-first path.
  const role = computeRole(el);
  const name = accessibleName(el);
  if (role && name) {
    const selector: Selector = { strategy: "role", role, name };
    disambiguate(selector, el);
    return selector;
  }

  // 3. Visible text.
  const text = normalize(el.textContent);
  if (text && text.length <= 80) {
    const selector: Selector = { strategy: "text", text };
    disambiguate(selector, el);
    if (!role) {
      selector.warning =
        "접근성 role이 없는 요소예요. 버튼/링크라면 적절한 태그나 role을 지정하면 더 안정적입니다.";
    }
    return selector;
  }

  // 4. CSS — fragile, always warn.
  return {
    strategy: "css",
    css: cssPath(el),
    warning:
      "접근성 정보(role/name)가 없어 CSS 선택자로만 특정했어요. 유지보수에 취약하니 꼭 필요할 때만 사용하세요.",
  };
}

/** If a selector matches multiple elements, pin it to the right nth + warn. */
function disambiguate(selector: Selector, el: Element): void {
  const matches = findElements(selector);
  if (matches.length <= 1) return;
  const index = matches.indexOf(el);
  if (
    index >= 0 &&
    (selector.strategy === "role" || selector.strategy === "text")
  ) {
    selector.nth = index;
    selector.warning =
      `화면에 동일한 요소가 ${matches.length}개 있어 ${index + 1}번째로 특정했어요. ` +
      "상위에 구분되는 접근성 컨테이너를 추가하면 더 견고해집니다.";
  }
}

// ---------------------------------------------------------------------------
// Finding elements from a Selector (used for uniqueness checks & replay).
// ---------------------------------------------------------------------------

export function findElements(selector: Selector): Element[] {
  switch (selector.strategy) {
    case "testid": {
      const sel = TESTID_ATTRS.map(
        (a) => `[${a}="${CSS.escape(selector.testid)}"]`,
      ).join(",");
      return Array.from(document.querySelectorAll(sel));
    }
    case "role": {
      const out: Element[] = [];
      const all = document.querySelectorAll("*");
      all.forEach((node) => {
        if (
          computeRole(node) === selector.role &&
          accessibleName(node) === selector.name
        ) {
          out.push(node);
        }
      });
      return out;
    }
    case "text": {
      const out: Element[] = [];
      const all = document.querySelectorAll("*");
      all.forEach((node) => {
        if (normalize(node.textContent) !== selector.text) return;
        const childOwnsSame = Array.from(node.children).some(
          (c) => normalize(c.textContent) === selector.text,
        );
        if (!childOwnsSame) out.push(node);
      });
      return out;
    }
    case "css": {
      try {
        return Array.from(document.querySelectorAll(selector.css));
      } catch {
        return [];
      }
    }
  }
}

export function findElement(selector: Selector): Element | null {
  const matches = findElements(selector);
  if (matches.length === 0) return null;
  const nth =
    "nth" in selector && typeof selector.nth === "number" ? selector.nth : 0;
  return matches[nth] ?? matches[0];
}
