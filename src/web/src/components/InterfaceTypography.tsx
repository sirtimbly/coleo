import { useEffect } from 'react';

const CONTROL_SELECTOR = [
  'button',
  'a',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
].join(',');

const DISPLAY_SELECTOR = 'h1,h2,h3,h4,h5,h6,label,legend,th,caption,dt';
const TYPOGRAPHY_SELECTOR = `${CONTROL_SELECTOR},${DISPLAY_SELECTOR}`;

const WORD_PATTERN = /\p{L}[\p{L}\p{M}'’-]*/gu;

function hasDirectText(element: Element): boolean {
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isEligible(element: HTMLElement): boolean {
  if (element.closest('p, pre, code, input, textarea, select, [contenteditable="true"]')) {
    return false;
  }

  const isControl = element.matches(CONTROL_SELECTOR);
  if (!isControl && !element.matches(DISPLAY_SELECTOR) && !hasDirectText(element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
  return isVisible && (isControl || Number.parseFloat(style.fontSize) > 12);
}

function applyInterfaceTypography(): void {
  const candidates = new Set<HTMLElement>();

  document.querySelectorAll<HTMLElement>(TYPOGRAPHY_SELECTOR).forEach((element) => candidates.add(element));

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    if (node.parentElement) candidates.add(node.parentElement);
    node = walker.nextNode();
  }

  document.querySelectorAll<HTMLElement>('[data-interface-typography]').forEach((element) => candidates.add(element));

  candidates.forEach((element) => {
    if (!isEligible(element)) {
      element.removeAttribute('data-interface-typography');
      element.removeAttribute('data-single-word');
      return;
    }

    element.setAttribute('data-interface-typography', 'true');
    const words = visibleText(element).match(WORD_PATTERN) ?? [];
    if (words.length === 1) {
      element.setAttribute('data-single-word', 'true');
    } else {
      element.removeAttribute('data-single-word');
    }
  });
}

export function InterfaceTypography() {
  useEffect(() => {
    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(applyInterfaceTypography);
    };

    scheduleUpdate();
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
