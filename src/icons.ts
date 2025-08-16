import * as fs from "fs-extra";
import FileType from "file-type";
import { verbose } from "./log";
import { NotionPage } from "./NotionPage";

let iconOutputPath = "";
let iconPrefixInMarkdown = "";

export async function initIconHandling(
  outputPath: string,
  prefixInMarkdown: string
): Promise<void> {
  // Set up icon output directory (default to static/icons)
  iconOutputPath = outputPath || "./static/icons";
  iconPrefixInMarkdown = prefixInMarkdown || "/icons";
  
  // Create icons directory
  await fs.mkdir(iconOutputPath, { recursive: true });
  verbose(`Icon handling initialized: output=${iconOutputPath}, prefix=${iconPrefixInMarkdown}`);
}

export async function processPageIcon(page: NotionPage): Promise<string | undefined> {
  const iconType = page.iconType;
  
  if (!iconType) return undefined;
  
  if (iconType === 'emoji') {
    return page.icon; // Return emoji directly
  }
  
  if (iconType === 'file' || iconType === 'external') {
    const iconUrl = page.iconUrl;
    if (!iconUrl) return undefined;
    
    try {
      // Download and save the icon
      const localIconPath = await downloadIcon(iconUrl, page.pageId);
      if (localIconPath) {
        // Return HTML img tag for Docusaurus
        return `<img src="${localIconPath}" width="16" height="16" style="display: inline; margin-right: 8px; vertical-align: middle;" alt="icon" />`;
      }
    } catch (error) {
      verbose(`Failed to download icon for page ${page.nameOrTitle}: ${error}`);
    }
  }
  
  return undefined;
}

async function downloadIcon(url: string, pageId: string): Promise<string | undefined> {
  try {
    verbose(`Downloading icon: ${url}`);
    
    // Fetch the icon
    const response = await fetch(url);
    if (!response.ok) {
      verbose(`Failed to fetch icon: ${response.status} ${response.statusText}`);
      return undefined;
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Detect file type
    const fileType = await FileType.fromBuffer(buffer);
    const extension = fileType?.ext || 'svg'; // Default to svg for Notion icons
    
    // Generate filename
    const filename = `${pageId}.${extension}`;
    const outputFilePath = `${iconOutputPath}/${filename}`;
    const markdownPath = `${iconPrefixInMarkdown}/${filename}`;
    
    // Write file
    await fs.writeFile(outputFilePath, buffer);
    verbose(`Icon saved: ${outputFilePath}`);
    
    return markdownPath;
  } catch (error) {
    verbose(`Error downloading icon: ${error}`);
    return undefined;
  }
}

export function getIconForDisplay(page: NotionPage, processedIconPath?: string): string | undefined {
  const iconType = page.iconType;
  
  if (!iconType) return undefined;
  
  if (iconType === 'emoji') {
    return page.icon;
  }
  
  if (processedIconPath) {
    return processedIconPath;
  }
  
  return undefined;
}