// Import necessary modules
const puppeteer = require('puppeteer'); // Headless Chrome browser automation library
const fs = require('fs'); // File system module for reading/writing files
const path = require('path'); // Module for handling file and directory paths
const process = require('process'); // Module providing information about, and control over, the current Node.js process
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); // Library for parsing PDF files (legacy build)
const { PDFDocument } = require('pdf-lib'); // Library for creating and modifying PDF documents

// Configure the worker source for pdfjs-dist. This is required for it to function correctly.
pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, 'pdf.worker.min.js');

// Define the standard name for the input HTML report file.
const REPORT_HTML = "rapport.html";

// Define command-line arguments for launching Chromium/Chrome via Puppeteer.
// These flags are often used to optimize performance and ensure compatibility in containerized/server environments.
const CHROME_PARAMETERS = [
  '--no-sandbox', // Disables the Chrome sandbox (often required in Docker/Linux environments)
  '--disable-setuid-sandbox', // Disables the setuid sandbox (alternative to --no-sandbox)
  '--disable-dev-shm-usage', // Overcomes resource limitations in /dev/shm under Docker
  '--disable-accelerated-2d-canvas', // Disables GPU hardware acceleration for 2D canvas
  '--no-first-run', // Skips the first run wizards
  '--no-zygote', // Disables the use of a zygote process for forking child processes
  '--disable-gpu', // Disables GPU hardware acceleration entirely
  '--hide-scrollbars', // Hides scrollbars from screenshots/PDFs
  '--mute-audio', // Mutes audio playback
  '--font-render-hinting=none'
];

class Browser {
    static instance = null;
    static async getInstance() {
        if (this.instance != null) {
            for (const page in this.instance.pages()) {
                page.close();
            }
            return this.instance;
        }
        try {
            // Launch Puppeteer
            log("Launching Puppeteer for PDF generation...");
            this.instance = await puppeteer.launch({
                headless: 'new',
                dumpio: true,
                devtools: false, // Disable devtools for production/automation
                executablePath: process.env.CHROMIUM_PATH,
                args: CHROME_PARAMETERS,
                pipe: true,
                product: 'chrome',
            });
            log("Puppeteer launched successfully.");
        } catch (err) {
            console.error(`Puppeteer launch failed: ${err}`);
            throw new Error(`Puppeteer launch failed: ${err}`);
            // No return needed
        }

        return this.instance;
    }
}

/**
 * Extracts the outer HTML of the element with ID "header-container" from the page.
 * This is used for the header on all pages except the first.
 * @param {puppeteer.Page} page - The Puppeteer page object.
 * @returns {Promise<string>} The outer HTML of the header element or a fallback message.
 */
const getHeaderAndFooter = async page => {
    return page.evaluate((_) => { // page.evaluate runs code within the browser context
        const header = document.getElementById("header-first-page");
        const footer = document.getElementById("footer-first-page");
        return [
            header ? header.outerHTML : "<div>header missing</div>",
            footer ? footer.outerHTML : "<div>Footer missing</div>"
        ];
    });
};


/**
 * Extracts the outer HTML of the element with ID "header-container" from the page.
 * This is used for the header on all pages except the first.
 * @param {puppeteer.Page} page - The Puppeteer page object.
 * @returns {Promise<string>} The outer HTML of the header element or a fallback message.
 */
const getHeader = async page => {
    return page.evaluate((_) => { // page.evaluate runs code within the browser context
        const header = document.getElementById("header-container");
        return header ? header.outerHTML : "<div>header missing</div>"; // Return HTML or fallback
    });
};

/**
 * Extracts the outer HTML of the element with ID "footer" from the page.
 * This is intended for the footer of the *first* page specifically.
 * @param {puppeteer.Page} page - The Puppeteer page object.
 * @returns {Promise<string>} The outer HTML of the first page footer element or a fallback message.
 */
const getFooter = async page => {
    return page.evaluate((_) => {
        const footer = document.getElementById("footer");
        return footer ? footer.outerHTML : "<div>Footer first page missing</div>";
    });
}

/**
 * Modifies the page's DOM to hide the first section (identified by ID "presentation")
 * and returns the entire HTML content of the modified page.
 * Used to generate the PDF content for all pages *after* the first.
 * @param {puppeteer.Page} page - The Puppeteer page object.
 * @returns {Promise<string>} The full HTML of the page with the first section hidden.
 */
const getAllSectionsExceptFirst = async (page, extrapages) => {
    return page.evaluate((extrapages) => {
        const element = document.getElementById("presentation"); // Assumes the first section always has this ID
        if (element) {
            element.style.display = 'flex'; // Hide the element
            if(extrapages == 0) {
                for (const child of element.children) {
                    child.style.display = 'none'; 
                }
            }
        }

        const sections = document.querySelectorAll('section'); // Select all section elements
        sections.forEach((section, i) => {
            if (i !== 0) { // If it's not the first section (index 0)
                section.style.display = 'flex'; // Hide it
            }
        });
        
        return document.documentElement.outerHTML; // Return the modified HTML
    }, extrapages);
}

/**
 * Modifies the page's DOM to hide all <section> elements except the first one.
 * Returns the entire HTML content of the modified page.
 * Used to generate the PDF content for *only* the first page.
 * @param {puppeteer.Page} page - The Puppeteer page object.
 * @returns {Promise<string>} The full HTML of the page with only the first section visible.
 */
const getFirstSection = async page => {
    return page.evaluate(() => {
        const sections = document.querySelectorAll('section'); // Select all section elements
        sections.forEach((section, i) => {
            if (section.id !== "presentation") { // If it's not the first section (index 0)
                section.style.display = 'none'; // Hide it
            }
        });
        const header = document.getElementById("header-first-page");
        const footer = document.getElementById("footer-first-page");
        return [
            document.documentElement.outerHTML, 
            header ? header.outerHTML : "<div>header first page missing</div>",
            footer ? footer.outerHTML : "<div>Footer first page missing</div>"
        ]; // Return the modified HTML
    });
};

/**
 * Analyzes a parsed PDF document to find on which page each TOC title appears.
 * This function iterates through PDF pages (starting from page 3, skipping potential cover/TOC pages),
 * extracts text content, and checks if the accumulated text includes any of the known TOC titles.
 * NOTE: The comment "-- Gros bricolage --" indicates this is considered a hacky/fragile approach.
 * It relies on text matching and might break if title formatting or PDF structure changes.
 * A more robust solution might involve embedding specific markers in the HTML.
 * @param {pdfjs.PDFDocumentProxy} pdf - The parsed PDF document object from pdfjs.
 * @param {string[]} table_of_content - An array of TOC title strings to search for.
 * @returns {Promise<Object>} An object where keys are page numbers (adjusted by -1) and values are arrays of TOC entry indices found on that page. Example: { 2: [0, 1], 4: [2] }
 */
async function find_page_number(pdf, table_of_content, extrapages) {
    //  -- Gros bricolage -- (Hack/Workaround)
    //    Could be improved in the future by
    //    measuring document elements or using markers.
    let titlesPages = {}; // Object to store page numbers for each title index
    let foundTitles = []
    // Start from page 3, assuming pages 1 and 2 are cover/TOC. Adjust if needed.
    for (let pageNb = 3; pageNb <= pdf.numPages; pageNb++) {
        const pdfPage = await pdf.getPage(pageNb); // Get page object
        const pageContent = await pdfPage.getTextContent(); // Extract text items

        let scrapText = ""; // Accumulator for text on the current page
        // Iterate through text items on the page
        for (let j = 0; j < pageContent.items.length; j++) {
            // Append text item content, removing potential newlines within items
            scrapText += pageContent.items[j].str.replace("\n", "");

            // Check if the accumulated text contains any of the TOC titles
            table_of_content.forEach((title, index) => {
                if (scrapText.includes(title)) {
                    if (!foundTitles.includes(title) && extrapages > 0) {
                        foundTitles.push(title);
                    } else {
                        // Initialize array for this page number if it doesn't exist
                        if (!titlesPages[pageNb]) {
                            titlesPages[pageNb] = [];
                        }

                        // Add the index of the found title to the page's list
                        titlesPages[pageNb].push(index);
                    }

                    // Optional: Log found titles and pages
                    //log(`Title found: ${title} on page ${i} (adjusted to ${pageNb})`);

                    // Reset accumulator after a match to avoid re-matching parts of the same title
                    scrapText = "";
                }
            });
        }
    }
    return titlesPages; // Return the mapping of page numbers to title indices
}


/**
 * Orchestrates the process of updating the table of contents with page numbers.
 * 1. Selects the correct list of TOC titles based on the report type.
 * 2. Calls `find_page_number` to determine where each title appears in the preliminary PDF.
 * 3. Calls `add_number_to_sommaire` to inject the page numbers into the HTML DOM.
 * @param {puppeteer.Page} page - The Puppeteer page object containing the HTML.
 * @param {pdfjs.PDFDocumentProxy} pdf - The parsed preliminary PDF document.
 * @param {string} rapportType - The type of report ('recensement' or 'evaluation_detaillee').
 * @returns {Promise<void>}
 * @throws {Error} If the report type is unknown.
 */
async function updateTableOfContent(page, pdf, extrapages) {
    log("Mise à jour du sommaire.");
    const tableOfContent = await page.$('#table-of-content'); // Get the TOC container element handle
    if (!tableOfContent) {
        log("Le sommaire n'a pas été trouvé !");
        return;
    }

    const titles = await page.evaluate(toc => {
        const titles = [];
        Array.from(toc.children).forEach(currentChild => {
            if (currentChild) {
                let link = currentChild.children[0];
                titles.push(link.textContent);
            }
        });
        return titles;
    }, tableOfContent);

    // Find the page number for each title in the PDF (executed in Node.js environment)
    let titlesPages = await find_page_number(pdf, titles, extrapages);

    // Update the DOM with page numbers (executed in browser environment)
    await page.evaluate((titlesPages) => {
        const toc = document.getElementById('table-of-content');
        if (!toc) {
            console.error("Le sommaire n'a pas été trouvé !");
            return;
        }

        for (const [page, childs] of Object.entries(titlesPages)) {
            childs.forEach(childIndex => {
                const currentChild = toc.children[childIndex];
                if (currentChild) {
                    let link = currentChild.querySelector('a');

                    let titlePage = document.createElement('span');
                    titlePage.className = link.textContent.includes(".") ? 'subtitle-page-number': 'title-page-number';
                    titlePage.textContent = page;

                    let dots = document.createElement('span');
                    dots.className = 'dots';
                    if (link) {
                        link.appendChild(dots);
                        link.appendChild(titlePage);
                    }
                }
            });
        }
    }, titlesPages);

    log('Fin de la mise à jour du sommaire.');
}

async function updatePageCount(page, firstPagesCount) {
    log("Mise à jour du total des pages.");
    const count = await page.$eval('.totalPages', (element, count) => element.textContent = count, firstPagesCount);
    log('Fin de la mise à jour du total des pages. ' + await page.$eval('.totalPages', (element) => element.textContent));
}

/**
 * Mergves two PDF buffers into a single PDF document using pdf-lib.
 * It takes the first page from the first PDF and prepends it to the second PDF,
 * removing a potentially blank second page from the second PDF (which might result
 * from hiding the first section).
 * @param {Buffer[]} pdfBuffers - An array containing two PDF buffers (first page PDF, rest of pages PDF).
 * @returns {Promise<Uint8Array>} A buffer containing the merged PDF data.
 * @throws {Error} If loading or merging PDFs fails.
 */
async function mergePDFs(pdfBuffers, extrapages) {
    if (pdfBuffers.length !== 2) {
        throw new Error("mergePDFs requires exactly two PDF buffers.");
    }

    // Load the two PDF buffers into pdf-lib documents
    const firstPDFDoc = await PDFDocument.load(pdfBuffers[0]); // Contains only the first page content
    const restPDFDoc = await PDFDocument.load(pdfBuffers[1]); // Contains the rest of the pages

    // Remove the (now) second page (index 1) from the second document.
    // This page is likely blank or contains minimal content because the
    // corresponding section was hidden in the HTML before generating restPDFDoc.
    // If the structure changes, this index might need adjustment.
    // It was originally page 0 of restPDFDoc before insertion.
    // After insertion, the original page 0 is at index 1, original page 1 is at index 2 etc.
    // The original code removed page 2, which implies the original restPDFDoc might have had
    // a blank page followed by the actual content starting on its page 2. Let's stick to that logic.
    restPDFDoc.removePage(0);
    if (extrapages > 0) {
        for (let i = 0; i < extrapages; i++) {
            firstPDFDoc.removePage(1);
        }
    }

    // firstPDFDoc.getPages().forEach((_) => {
    //      restPDFDoc.removePage(0); // Remove the page originally at index 1 in restPDFDoc
    // });

    // const firstPagePages = firstPDFDoc.getPages().map((_, index) => index);

    // Copy the first page from the first document into the second document
    // We only need the first page ([0]) from firstPDFDoc
    const [copiedPages] = await restPDFDoc.copyPages(firstPDFDoc, [0]);

    // Insert the copied first page at the beginning (index 0) of the second document
    // copiedPages.forEach((page, index) => {
    //     restPDFDoc.insertPage(index, page);
    // });
    
    restPDFDoc.insertPage(0, copiedPages);


    // Save the modified second document (which now contains all pages) into a buffer
    const mergedPdfBuffer = await restPDFDoc.save();

    return mergedPdfBuffer; // Return the merged PDF data
}

function log(text) {
    console.log(`${new Date().toUTCString()} - ${text}`)
}

/**
 * Generates an intermediate HTML file with an updated table of contents.
 * 1. Launches Puppeteer.
 * 2. Reads the initial HTML file (`rapport.html`).
 * 3. Loads the HTML into a Puppeteer page.
 * 4. Extracts header/footer templates.
 * 5. Generates a *preliminary* PDF (in memory) using the initial HTML. This PDF is *only* used to determine page numbers for the TOC.
 * 6. Parses the preliminary PDF using `pdfjs`.
 * 7. Calls `updateTableOfContent` to add page numbers to the HTML DOM in the Puppeteer page.
 * 8. Saves the *modified* HTML content (with page numbers in the TOC) to the final HTML output file.
 * 9. Closes the browser.
 * @returns {Promise<void>}
 * @throws {Error} If Puppeteer fails to launch or if `updateTableOfContent` throws an error.
 */
async function generateHTML(htmlPage) {
    const browser = await Browser.getInstance();

    // Log the browser version being used
    const version = await browser.version();
    log("Chrome version:", version);
    
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36");
    await page.setContent(htmlPage, { waitUntil: 'domcontentloaded' });

    return page;
}




/**
 * Generates the final PDF report by splitting the HTML into two parts (first page vs. rest)
 * and merging the resulting PDFs.
 * 1. Launches Puppeteer.
 * 2. Reads the *final* HTML (generated by `generateHTML`, containing the updated TOC).
 * 3. **Part 1 (First Page):**
 *    - Loads the HTML into a page.
 *    - Uses `getFirstSection` to isolate the first section's content.
 *    - Renders this content to a temporary PDF (`0.pdf`) with the first page header/footer.
 * 4. **Part 2 (Remaining Pages):**
 *    - Loads the HTML into another page.
 *    - Uses `getAllSectionsExceptFirst` to isolate the remaining content.
 *    - Renders this content to a temporary PDF (`1.pdf`) with the standard header/footer.
 * 5. Closes the browser.
 * 6. Calls `mergePDFs` to combine `0.pdf` and `1.pdf`.
 * 7. Deletes the temporary PDF files.
 * 8. Saves the merged PDF to the final output path.
 * @returns {Promise<void>}
 * @throws {Error} If Puppeteer fails, file reading fails, PDF generation fails, or merging fails.
 */
async function generatePDF(htmlPage) {
    const browser = await Browser.getInstance();

    // Define PDF generation options for this part
    const options = {
        format: 'A4',
        displayHeaderFooter: true, // Enable header/footer rendering
        printBackground: true, // Ensure background colors/images are printed
        headerTemplate: "", // Use the determined header template
        footerTemplate: "", // Use the determined footer template
        preferCSSPageSize: false, // Use @page size rules from CSS if available
        margin: { bottom: '25mm', top: '20mm' }, // margins
    };

    const pdfBuffers = []; // Array to hold the generated PDF buffers

    // Log browser version
    const version = await browser.version();
    log("Chrome version:", version);

    // Create a page for loading the full HTML and extracting parts
    const page1 = htmlPage;
    const page2 = await browser.newPage();
    await page2.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36");

    let [content_after, header, footer] = await getFirstSection(page1); // Get HTML with only the first section visible

    await page2.setContent(content_after, { waitUntil: 'domcontentloaded' });

    await page1.evaluate(() => {
        const sections = document.querySelectorAll('section'); // Select all section elements
        sections.forEach((section, _) => {
            section.style.display = 'flex'; // show it
        });
    });

    let extrapages = 0;

    try {
        // Generate the preliminary PDF as a buffer
        log("Generating preliminary PDF for page number analysis...");
        const pdfContent = await page2.pdf(options);

        // Prepare the PDF data for pdfjs
        const pdfData = new Uint8Array(pdfContent);

        // Load the PDF data using pdfjs
        var loadingTask = pdfjs.getDocument(pdfData);
        const pdf = await loadingTask.promise;

        extrapages = pdf.numPages - 1;
    } catch (err) {
        console.error("Erreur lors de la récupération des pages initiales supplémentaires.", err);
        throw err; // Re-throw the specific error
    }

    try {
        // Generate the preliminary PDF as a buffer
        log("Generating preliminary PDF for page number analysis...");
        const pdfContent = await page1.pdf(options);
        log("Preliminary PDF generated in memory.");

        // Prepare the PDF data for pdfjs
        const pdfData = new Uint8Array(pdfContent);

        log("Parsing preliminary PDF with pdfjs...");
        // Load the PDF data using pdfjs
        var loadingTask = pdfjs.getDocument(pdfData);
        const pdf = await loadingTask.promise; // Wait for the PDF to be parsed

        log("Preliminary PDF parsed. Pages count: " + (pdf.numPages));
        // Update the table of contents in the HTML DOM based on the parsed PDF
        await updatePageCount(page1, pdf.numPages);
        await updateTableOfContent(page1, pdf, extrapages);
        // await updatePageCount(page, pdf);
    } catch (err) {
        // Handle errors during TOC update (e.g., unknown report type)
        console.error("Error updating table of content:", err);
        throw err; // Re-throw the specific error
        // No return needed here
    }

    [content_after, header, footer] = await getFirstSection(page1); // Get HTML with only the first section visible

    // Loop twice: once for the first page, once for the rest
    for (let i = 0; i < 2; i++) {
        log(`--- Generating PDF Part ${i + 1} ---`);

        if (i !== 0) {
            content_after = await getAllSectionsExceptFirst(page1, extrapages); // Get HTML with the first section hidden

            await fs.writeFileSync("output.html", content_after);
        }

        // Create a second page specifically for rendering the PDF part
        // This avoids potential side effects from DOM manipulation on page1 affecting rendering
        log("Loading extracted content into rendering page...");
        await page2.setContent(content_after, { waitUntil: 'domcontentloaded' }); // Load the isolated HTML part
        log("Extracted content loaded.");

        if (i !== 0) {
            // --- Part 2: Remaining Pages ---
            log("Extracting content for remaining sections...");
            // Use the standard header and footer for subsequent pages
            header = await getHeader(page2);
            footer = await getFooter(page2);

            log("Remaining sections extracted.");

            options.margin.top = '35mm';
        }

        options.headerTemplate = header;
        options.footerTemplate = footer;

        log(`Generating PDF buffer for part ${i + 1}...`);
        // Generate the PDF for the current part as a buffer

        const pdfBuffer = await page2.pdf(options);
        pdfBuffers.push(pdfBuffer); // Add the buffer to the array
        log(`PDF buffer for part ${i + 1} generated.`);
        log(`Temporary pages for part ${i + 1} closed.`);
    } // End of loop

    // Close the temporary pages used for this part
    await page2.close();
    await page1.close();

    // Close the browser instance now that both parts are generated
    log("Browser closed after generating PDF parts.");

    // Check if we have the expected number of PDF buffers
    if (pdfBuffers.length !== 2) {
        throw new Error(`Expected 2 PDF buffers, but got ${pdfBuffers.length}`);
    }

    return await mergePDFs(pdfBuffers, extrapages);
}

/**
 * Generates an intermediate HTML file with an updated table of contents.
 * 1. Launches Puppeteer.
 * 2. Reads the initial HTML file (`rapport.html`).
 * 3. Loads the HTML into a Puppeteer page.
 * 4. Extracts header/footer templates.
 * 5. Generates a *preliminary* PDF (in memory) using the initial HTML. This PDF is *only* used to determine page numbers for the TOC.
 * 6. Parses the preliminary PDF using `pdfjs`.
 * 7. Calls `updateTableOfContent` to add page numbers to the HTML DOM in the Puppeteer page.
 * 8. Saves the *modified* HTML content (with page numbers in the TOC) to the final HTML output file.
 * 9. Closes the browser.
 * @returns {Promise<void>}
 * @throws {Error} If Puppeteer fails to launch or if `updateTableOfContent` throws an error.
 */
async function createHTMLFile() {
    // Get command line arguments: output file name, output path, report type
    const reportName = process.argv[3]; // e.g., "final_report.html"
    const outputPath = process.argv[4]; // e.g., "/path/to/output"
    const rapportType = process.argv[5]; // e.g., "recensement"

    // Log messages from the browser console to the Node console
    console.log("Generating intermediate HTML from ", outputPath);
    let content;
    try {
        // Read the initial HTML report content
        content = fs.readFileSync(path.join(outputPath, REPORT_HTML), "utf8");
    } catch (readErr) {
        console.error(`Failed to read input HTML file: ${path.join(outputPath, REPORT_HTML)}`, readErr);
        throw new Error(`Failed to read input HTML: ${readErr.message}`);
    }

    try {
        // Get the final HTML content (with updated TOC) from the page
        const finalHtmlContent = await generateHTML(content);
        // Write the final HTML to the specified output file
        fs.writeFileSync(path.join(outputPath, reportName), await finalHtmlContent.content());
        console.log(`Final HTML with updated TOC saved to: ${path.join(outputPath, reportName)}`);
    } catch (writeErr) {
        console.error(`Failed to write final HTML file: ${path.join(outputPath, reportName)}`, writeErr);
        throw new Error(`Failed to write final HTML: ${writeErr.message}`);
    }
}


/**
 * Generates the final PDF report by splitting the HTML into two parts (first page vs. rest)
 * and merging the resulting PDFs.
 * 1. Launches Puppeteer.
 * 2. Reads the *final* HTML (generated by `generateHTML`, containing the updated TOC).
 * 3. **Part 1 (First Page):**
 *    - Loads the HTML into a page.
 *    - Uses `getFirstSection` to isolate the first section's content.
 *    - Renders this content to a temporary PDF (`0.pdf`) with the first page header/footer.
 * 4. **Part 2 (Remaining Pages):**
 *    - Loads the HTML into another page.
 *    - Uses `getAllSectionsExceptFirst` to isolate the remaining content.
 *    - Renders this content to a temporary PDF (`1.pdf`) with the standard header/footer.
 * 5. Closes the browser.
 * 6. Calls `mergePDFs` to combine `0.pdf` and `1.pdf`.
 * 7. Deletes the temporary PDF files.
 * 8. Saves the merged PDF to the final output path.
 * @returns {Promise<void>}
 * @throws {Error} If Puppeteer fails, file reading fails, PDF generation fails, or merging fails.
 */
async function createPDFFile() {
    // Get command line arguments
    const reportName = process.argv[3]; // e.g., "final_report.pdf"
    const outputPath = process.argv[4]; // e.g., "/path/to/output"

    // Determine the input HTML file name (derived from the target PDF name)
    const inputHtmlFileName = reportName.replace(".pdf", ".html");
    const inputHtmlPath = path.join(outputPath, inputHtmlFileName);

    let content_before; // Variable to hold the HTML content
    try {
        // Read the final HTML content (generated by generateHTML)
        console.log(`Reading final HTML from: ${inputHtmlPath}`);
        content_before = fs.readFileSync(inputHtmlPath, "utf8");
        console.log("Final HTML read successfully.");
    } catch (err) {
        console.error(`Failed to read final HTML file: ${inputHtmlPath}`, err);
        throw new Error(`File not found: ${inputHtmlPath}`);
        // No return needed
    }

    const browser = await Browser.getInstance();
    const page = await browser.newPage();
    await page.setContent(content_before, { waitUntil: 'domcontentloaded' }); 

    const mergedPdfBuffer = await generatePDF(page);

    try {
        // Write the final merged PDF to the specified output file
        const finalPdfPath = path.join(outputPath, reportName);
        fs.writeFileSync(finalPdfPath, mergedPdfBuffer);
        console.log('Final merged PDF saved successfully:', finalPdfPath);
    } catch (mergeErr) {
        console.error("Error during PDF merging or saving:", mergeErr);
        throw new Error(`PDF merging/saving failed: ${mergeErr.message}`);
    } finally {
        // Clean up temporary individual PDF files if they were saved (currently they are in memory)
        // If options.path was used in the loop, uncomment the cleanup:
        // pdfBuffers.forEach((_, i) => {
        //     const tempPdfPath = path.join(outputPath, i + ".pdf");
        //     try {
        //         if (fs.existsSync(tempPdfPath)) {
        //             fs.rmSync(tempPdfPath);
        //             console.log(`Removed temporary file: ${tempPdfPath}`);
        //         }
        //     } catch (cleanupErr) {
        //         console.warn(`Could not remove temporary file ${tempPdfPath}:`, cleanupErr);
        //     }
        // });
    }
}


/**
 * Main execution function.
 * Parses command line arguments to determine whether to generate HTML or PDF.
 * Calls the appropriate generation function and handles top-level errors.
 */
async function main() {
    // Check if enough arguments are provided (node script.js <action> ...)
    if (process.argv.length <= 2) {
        console.log("Usage: node index.js <pdf|html> <output_name> <output_path> [report_type]");
        return; // Exit if no action specified
    }

    // Get the action (pdf or html) from the command line arguments
    const action = process.argv[2].toLowerCase();

    // Branch based on the specified action
    switch (action) {
        case "pdf":
            try {
                // Call the PDF generation function
                await createPDFFile();
                console.log('PDF generated successfully!');
            } catch (err) {
                // Log errors during PDF generation and exit with error code
                console.error('Error generating PDF:', err.message || err);
                process.exit(1); // Exit with a non-zero code to indicate failure
            }
            break; // Exit switch statement
        case "html":
            try {
                // Call the HTML generation function (updates TOC)
                await createHTMLFile();
                console.log('HTML generated successfully!');
            } catch (err) {
                // Log errors during HTML generation and exit with error code
                console.error('Error generating HTML:', err.message || err);
                process.exit(1); // Exit with a non-zero code to indicate failure
            }
            break; // Exit switch statement
        default:
            // Handle unknown actions
            console.error(`Unknown action: ${action}. Use 'pdf' or 'html'.`);
    }
    process.exit(0);
}

// Execute the main function and catch any unhandled promise rejections or errors
main().catch(err => {
    console.error('Unhandled error in main execution:', err.message || err);
    process.exit(1); // Exit with a non-zero code
});

// Export functions and constants that might be used by other modules or for testing
module.exports = {
    updateTableOfContent, // Function to update TOC (potentially for testing)
    createHTMLFile,
    createPDFFile,
    generateHTML,         // Main HTML generation function
    generatePDF          // Main PDF generation function (added for completeness, though not in original exports)
};