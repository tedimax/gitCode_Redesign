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
   * Overrides Sheet.fetchWindow
   * Pulls the latest file from Drive and populates the RAM cache.
   * Triggered lazily by getWindow() or explicitly by importData().
   */
  fetchWindow() {
    if (this._isFetched) return;
    myLog("info", "FileTable %s: Fetching raw data from Drive...", this.longName);
    
    const folderId = this.getProperty("FolderID");
    if (!folderId) {
      throw new Error(`CRITICAL: FileTable ${this.longName} is missing a FolderID in the Registry.`);
    }

    const driveMimeType = this._resolveMimeType(this.getProperty("MimeType"));
    const latestFile = this._getLatestFile(folderId, driveMimeType);

    if (!latestFile) {
      throw new Error(`CRITICAL: FileTable ${this.longName} failed to find any files in Folder ${folderId} of type ${driveMimeType}.`);
    }

    const parsedMatrix = this._parseFileContent(latestFile, driveMimeType);
    this._setWindowData(parsedMatrix);
  }

  /**
   * Overrides UpdateTable.commit
   * Safety override to prevent FileTables from ever physically writing back to Google Sheets.
   */
  commit() {
    myLog("info", "FileTable %s: commit() suppressed. FileTable is a read-only source.", this.longName);
    return { added: 0, updated: 0, removed: 0 };
  }

  /**
   * Safety Override for writeBlock.
   */
  writeBlock(startRow, matrix) {
    myLog("warn", "SAFETY: Blocked attempt to writeBlock to FileTable %s", this.longName);
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
    
    let latestFile = null;
    let latestDate = 0;

    while (filesIter.hasNext()) {
      const file = filesIter.next();
      const date = file.getLastUpdated().getTime();
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
    myLog("info", "FileTable %s: Parsing CSV data...", this.longName);
    const separator = this.getProperty("Separator") || ",";
    const ccsid = this.getProperty("CCSID") || "UTF-8";
    
    const dataStr = (ccsid === "UTF-8") ? blob.getDataAsString() : blob.getDataAsString(ccsid);
    return Utilities.parseCsv(dataStr, separator);
  }

  _setWindowData(parsedMatrix) {
    const startIdx = Math.max(0, this.firstDataRowIndex - 1);
    this._window = parsedMatrix.length > startIdx ? parsedMatrix.slice(startIdx) : [];
    this.windowDataLength = this._window.length;
    this._isFetched = true;
    myLog("info", "FileTable %s: Ingested %d data rows into RAM.", this.longName, this.windowDataLength);
  }
}

// Register with globals
globals.tableMap['FileTable'] = FileTable;
