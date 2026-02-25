import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from bs4 import element as BeautifulSoupElement
from markdownify import markdownify

# HTML element selectors to remove from PostGIS pages
POSTGIS_REMOVE_SELECTORS = [
    "script",
    "style",
    "header",
    "footer",
    ".navheader",
    ".navfooter",
    ".toc",
    ".titlepage .abstract img",
]

# Admonition class names whose h3 headings should be demoted to h4
# to avoid spurious chunk splits in PostgreSQL docs.
POSTGRES_ADMONITION_CLASSES = [
    "caution",
    "important",
    "notice",
    "warning",
    "tip",
    "note",
]


def clean_postgis_html(soup: BeautifulSoup) -> BeautifulSoup:
    """Remove navigation, scripts, styles, and data-URI images from PostGIS HTML."""
    for selector in POSTGIS_REMOVE_SELECTORS:
        for element in soup.select(selector):
            element.decompose()
    for img in soup.find_all("img", src=True):
        if img["src"].startswith("data:"):
            img.decompose()
    return soup


def extract_title(soup: BeautifulSoup, fallback: str = "Documentation") -> str:
    """Extract the page title from a BeautifulSoup document."""
    title_tag = soup.find("title")
    if title_tag:
        return title_tag.get_text().strip()
    for tag in ("h1", "h2"):
        el = soup.find(tag)
        if el:
            return el.get_text().strip()
    return fallback


def postgis_html_to_markdown(soup: BeautifulSoup) -> str:
    """Convert PostGIS HTML to Markdown, scoped to the main content element."""
    main_content = (
        soup.find("div", class_="refentry")
        or soup.find("div", class_="chapter")
        or soup.find("div", class_="section")
        or soup.find("div", class_="book")
        or soup.find("body")
        or soup
    )
    return markdownify(str(main_content), heading_style="ATX")


def postgres_html_to_markdown(soup: BeautifulSoup, is_refentry: bool) -> str:
    """Convert PostgreSQL HTML to Markdown.

    For non-refentry pages, demotes h3 headings inside admonition blocks to h4
    so they don't create spurious chunk splits.
    """
    if not is_refentry:
        for class_name in POSTGRES_ADMONITION_CLASSES:
            for div in soup.find_all("div", class_=class_name):
                if div is None or not isinstance(div, BeautifulSoupElement.Tag):
                    continue
                h3 = div.find("h3")
                if h3 and isinstance(h3, BeautifulSoupElement.Tag):
                    h3.name = "h4"

    return markdownify(str(soup), heading_style="ATX")


def fetch_page_as_soup(
    session: requests.Session,
    url: str,
    processed_urls: set[str],
    delay: float = 0.0,
) -> BeautifulSoup | None:
    """Fetch a URL and return a BeautifulSoup object, or None on error/already processed."""
    if url in processed_urls:
        return None
    try:
        if delay:
            time.sleep(delay)
        response = session.get(url, timeout=30)
        response.raise_for_status()
        processed_urls.add(url)
        return BeautifulSoup(response.content, "html.parser")
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return None


# Pages to skip when scraping PostGIS manual (index, table of contents, etc.)
POSTGIS_SKIP_PAGES = {
    "index.html",
    "bookindex.html",
    "PostGIS_Special_Functions_Index.html",
    "release_notes.html",
}


def get_postgis_page_urls(
    session: requests.Session,
    base_url: str,
    max_pages: int | None = None,
) -> list[str]:
    """Fetch the PostGIS manual index and return sorted list of page URLs."""
    print(f"Fetching manual index from {base_url}...")
    try:
        response = session.get(base_url, timeout=30)
        response.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"Failed to fetch manual index: {e}") from e

    soup = BeautifulSoup(response.content, "html.parser")
    pages = set()
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if href.endswith(".html") and not href.startswith("http") and href not in POSTGIS_SKIP_PAGES:
            pages.add(href)

    urls = sorted(pages)
    if max_pages:
        urls = urls[:max_pages]
    return urls


def extract_postgres_page_metadata(
    soup: BeautifulSoup,
) -> tuple[str, str, bool]:
    """Extract (title_text, slug, is_refentry) from a PostgreSQL HTML page."""
    is_refentry = bool(soup.find("div", class_="refentry"))

    elem = soup.find("div", attrs={"id": True})
    if elem and isinstance(elem, BeautifulSoupElement.Tag):
        slug = str(elem["id"]).lower() + ".html"
    else:
        raise SystemError("No div with id found in page")

    title = soup.find("title")
    title_text = (
        str(title.string).strip()
        if title and isinstance(title, BeautifulSoupElement.Tag)
        else "PostgreSQL Documentation"
    )

    # Remove title and nav elements before converting to markdown
    if title:
        title.decompose()
    for class_name in ["navheader", "navfooter"]:
        for div in soup.find_all("div", class_=class_name):
            div.decompose()

    return title_text, slug, is_refentry
