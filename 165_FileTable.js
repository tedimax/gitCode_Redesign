"use strict";

/**
 * gitCode_Redesign - FileTable (Level 3)
 * A specialized UpdateTable that retrieves data from Google Drive.
 * Primarily used as a Source for other tables. Does not physically update Google Sheets.
 */
class FileTable extends UpdateTable {
  constructor(ss, longName, properties = {}) {
    super(ss, longName, properties);
  }



  /**
   * Overrides Table.prepare
   * For FileTable, preparing simply means fetching the Drive data.
   */
  prepare() {
    this.fetchWindow();
    return this._window;
  }



  /**
   * Overrides Sheet.fetchWindow
   * Pulls the latest file from Drive and populates the RAM cache.
   * Triggered lazily by getWindow() or explicitly by importData().
   */
  fetchWindow() {
    if (this._isFetched) return;
    myLog("info", "FileTable %s: Fetching raw data from Drive...", this.longName);
    
    const driveMimeType = this._resolveMimeType(this.getProperty("MimeType"));
    
    let latestFile;
    const folderId = this.getProperty("FolderID");
    if (!folderId) {
      throw new Error(`CRITICAL: FileTable ${this.longName} is missing a FolderID in the Registry.`);
    }
    latestFile = this._getLatestFile(folderId, driveMimeType);

    if (!latestFile) {
      throw new Error(`CRITICAL: FileTable ${this.longName} failed to find any files in Folder ${folderId} of type ${driveMimeType}.`);
    }

    const parsedMatrix = this._parseFileContent(latestFile, driveMimeType);
    this._setWindowData(parsedMatrix);
  }


  persist(newData, mode) {
    if (this.ss) {
      // 0. Ensure sheet is initialized
      if (!this.sheet) this.sheet = this.ss.getSheetByName(this.sheetName);
      if (!this.sheet) {
        myLog("warn", "FileTable %s: Target sheet '%s' not found. Cannot write headers.", this.longName, this.sheetName);
      } else if (this._detectedHeaders && this._detectedHeaders.length > 0) {
        // 1. Physically write the headers to the sheet if we have them
        const labelRowIdx = Number(this.getProperty("LabelRow")) || 1;
        const matrix = [this._detectedHeaders];
        myLog("info", "FileTable %s: Writing %d headers to row %d: [%s]", 
          this.longName, this._detectedHeaders.length, labelRowIdx, this._detectedHeaders.slice(0, 5).join(", "));
        this.sheet.getRange(labelRowIdx, 1, 1, this._detectedHeaders.length).setValues(matrix);
        myLog("info", "FileTable %s: Physically wrote %d headers to row %d", this.longName, this._detectedHeaders.length, labelRowIdx);
      }

      // 2. Proceed with standard data persistence
      // For FileTable, we always force "replace" mode because a file ingest is a 1:1 replacement of the Drive file content.
      // If we use update/add mode, it causes logic bugs because the RAM window represents the Drive file, not the Sheet.
      const forcedMode = "replace";
      myLog("info", "FileTable %s: Forcing persistence mode to '%s' (ignoring requested '%s').", this.longName, forcedMode, mode);
      return super.persist(newData, forcedMode);
    }
    myLog("info", "FileTable %s: No physical sheet attached. persist() skipped.", this.longName);
    return { added: 0, updated: 0, removed: 0 };
  }


  /**
   * Safety Override for writeBlock.
   * If a spreadsheet is attached (Staging mode), we allow the write.
   */
  writeBlock(matrix, startRow) {
    if (this.ss) {
      return super.writeBlock(matrix, startRow);
    }
    myLog("warn", "SAFETY: Blocked attempt to writeBlock to virtual FileTable %s", this.longName);
  }

  // ==========================================
  // DISCRETE HELPER METHODS
  // ==========================================

  _resolveMimeType(mimeTypeConfig) {
    if (!mimeTypeConfig) return MimeType.CSV;
    
    const configStr = mimeTypeConfig.toString().toUpperCase();
    if (configStr.includes("EXCEL") || configStr.includes("XLS")) {
      return MimeType.MICROSOFT_EXCEL;
    } else if (configStr.includes("CSV")) {
      return MimeType.CSV;
    }
    return mimeTypeConfig;
  }

  _getLatestFile(folderId, driveMimeType) {
    const sourceFolder = DriveApp.getFolderById(folderId);
    const filesIter = sourceFolder.getFilesByType(driveMimeType);
    const nameFilter = this.getProperty("FilenameFilter");
    
    let latestFile = null;
    let latestDate = 0;

    myLog("info", "FileTable %s: Searching for %s files in folder %s...", this.longName, driveMimeType, folderId);
    
    while (filesIter.hasNext()) {
      const file = filesIter.next();
      const name = file.getName();
      const date = file.getLastUpdated().getTime();
      
      myLog("trace", "  - Candidate: %s (Updated: %s)", name, new Date(date).toISOString());
      
      if (nameFilter && !name.includes(nameFilter)) continue;
      
      if (date > latestDate) {
        latestDate = date;
        latestFile = file;
      }
    }

    if (latestFile) {
      myLog("info", "FileTable %s: Found latest file '%s' (Updated: %s)", this.longName, latestFile.getName(), new Date(latestDate).toISOString());
    }
    return latestFile;
  }

  _parseFileContent(file, driveMimeType) {
    const blob = file.getBlob();
    try {
      if (driveMimeType === MimeType.MICROSOFT_EXCEL) {
        return this._convertExcelBlobToMatrix(blob);
      } else {
        return this._parseCsvBlobToMatrix(blob);
      }
    } catch (e) {
      throw new Error(`FileTable ${this.longName} failed to parse file: ${e.message}`);
    }
  }

  _convertExcelBlobToMatrix(blob) {
    myLog("info", "FileTable %s: Triggering Advanced Drive API Excel Conversion...", this.longName);
    const newFile = {
      title: `Temp_Conversion_${this.longName}_${new Date().getTime()}`,
      mimeType: MimeType.GOOGLE_SHEETS
    };
    
    // @ts-ignore: Drive API v2 uses insert
    const converted = Drive.Files.insert(newFile, blob, { convert: true });
    if (!converted || !converted.id) throw new Error("Drive API failed to return converted ID.");
    
    let matrix = [];
    const tempSS = SpreadsheetApp.openById(converted.id);
    const sourceSheet = tempSS.getSheets()[0];
    
    if (sourceSheet) {
      const lastRow = sourceSheet.getLastRow();
      const lastCol = sourceSheet.getLastColumn();
      if (lastRow > 0 && lastCol > 0) {
        matrix = sourceSheet.getRange(1, 1, lastRow, lastCol).getValues();
      }
    }
    
    Drive.Files.remove(converted.id);
    myLog("info", "FileTable %s: Conversion cleanup complete.", this.longName);
    return matrix;
  }

  _parseCsvBlobToMatrix(blob) {
    let separator = this.getProperty("Separator") || ",";
    if (separator === "\\t") separator = "\t";
    
    const ccsid = this.getProperty("CCSID") || "UTF-8";
    const dataStr = (ccsid === "UTF-8") ? blob.getDataAsString() : blob.getDataAsString(ccsid);

    if (separator === "," && this.longName.includes("SQTX")) {
       myLog("warn", "FileTable %s: WARNING: Parsing Square file with COMMA separator. Headers might not split correctly.", this.longName);
    }

    myLog("info", "FileTable %s: Parsing with separator CharCode(%d), Encoding: %s", 
      this.longName, separator.charCodeAt(0), ccsid);

    return Utilities.parseCsv(dataStr, separator);
  }

  _setWindowData(parsedMatrix) {
    if (parsedMatrix.length === 0) return;

    // 1. Extract headers from Row 1 and sync the column map
    this._detectedHeaders = parsedMatrix[0].map(h => String(h).trim());
    this._labels = this._detectedHeaders;
    myLog("info", "FileTable %s: Syncing columnMap with %d CSV headers: [%s]", this.longName, this._detectedHeaders.length, this._detectedHeaders.slice(0, 5).join(", "));
    
    this._columnMap = new Map(); 
    this._detectedHeaders.forEach((h, i) => {
      if (h) this._columnMap.set(h, i);
    });

    const startIdx = Math.max(0, this.firstDataRowIndex - 1);
    this._window = parsedMatrix.length > startIdx ? parsedMatrix.slice(startIdx) : [];
    this.windowDataLength = this._window.length;
    this._isFetched = true;
    myLog("info", "FileTable %s: Ingested %d data rows into RAM.", this.longName, this.windowDataLength);
  }
}

// Register with globals
globals.tableMap['FileTable'] = FileTable;
