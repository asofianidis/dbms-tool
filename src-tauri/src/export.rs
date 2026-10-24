//! Result exports written straight to disk: `query_export` streams a query's
//! rows into one of these sinks as the server produces them, and
//! `file_write_xlsx` writes rows the grid already holds.

use std::fs::File;
use std::io::{BufWriter, Seek, Write};

use serde::Deserialize;
use serde_json::Value;
use zip::write::SimpleFileOptions;

use crate::model::{ColumnMeta, RowSink};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Xlsx,
}

/// A sink writing `format` to the file at `path`.
pub fn sink(format: ExportFormat, path: &str) -> std::io::Result<Box<dyn RowSink>> {
    let file = File::create(path)?;
    Ok(match format {
        ExportFormat::Csv => Box::new(Delimited::new(file, b',')),
        ExportFormat::Tsv => Box::new(Delimited::new(file, b'\t')),
        ExportFormat::Json => Box::new(Json::new(file)),
        ExportFormat::Xlsx => Box::new(Xlsx::new(file)?),
    })
}

fn text(value: &Value) -> std::borrow::Cow<'_, str> {
    match value {
        Value::Null => "".into(),
        Value::String(s) => s.as_str().into(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        other => other.to_string().into(),
    }
}

/// CSV or TSV with a header row, quoting like the grid's own export (export.ts).
struct Delimited<W: Write> {
    out: BufWriter<W>,
    sep: u8,
}

impl<W: Write> Delimited<W> {
    fn new(out: W, sep: u8) -> Self {
        Self {
            out: BufWriter::with_capacity(1 << 16, out),
            sep,
        }
    }

    fn line<'a>(
        &mut self,
        cells: impl Iterator<Item = std::borrow::Cow<'a, str>>,
    ) -> std::io::Result<()> {
        for (i, cell) in cells.enumerate() {
            if i > 0 {
                self.out.write_all(&[self.sep])?;
            }
            let needs_quotes = cell
                .bytes()
                .any(|b| b == self.sep || b == b'"' || b == b'\n' || b == b'\r');
            if needs_quotes {
                self.out.write_all(b"\"")?;
                self.out.write_all(cell.replace('"', "\"\"").as_bytes())?;
                self.out.write_all(b"\"")?;
            } else {
                self.out.write_all(cell.as_bytes())?;
            }
        }
        self.out.write_all(b"\r\n")
    }
}

impl<W: Write + Send> RowSink for Delimited<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()> {
        self.line(columns.iter().map(|c| c.name.as_str().into()))
    }

    fn row(&mut self, row: &[Value]) -> std::io::Result<()> {
        self.line(row.iter().map(text))
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

/// A JSON array of objects keyed by column name, one object per line.
struct Json<W: Write> {
    out: BufWriter<W>,
    keys: Vec<String>,
    rows: u64,
}

impl<W: Write> Json<W> {
    fn new(out: W) -> Self {
        Self {
            out: BufWriter::with_capacity(1 << 16, out),
            keys: Vec::new(),
            rows: 0,
        }
    }
}

impl<W: Write + Send> RowSink for Json<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()> {
        self.keys = columns
            .iter()
            .map(|c| serde_json::to_string(&c.name).unwrap_or_else(|_| "\"\"".into()))
            .collect();
        self.out.write_all(b"[")
    }

    fn row(&mut self, row: &[Value]) -> std::io::Result<()> {
        self.out
            .write_all(if self.rows == 0 { b"\n  {" } else { b",\n  {" })?;
        for (i, (key, value)) in self.keys.iter().zip(row).enumerate() {
            if i > 0 {
                self.out.write_all(b", ")?;
            }
            self.out.write_all(key.as_bytes())?;
            self.out.write_all(b": ")?;
            serde_json::to_writer(&mut self.out, value)?;
        }
        self.rows += 1;
        self.out.write_all(b"}")
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.out
            .write_all(if self.rows == 0 { b"]\n" } else { b"\n]\n" })?;
        self.out.flush()
    }
}

/// Excel's sheet limits: rows including the header, and characters per cell.
const XLSX_MAX_ROWS: u64 = 1_048_576;
const XLSX_MAX_CHARS: usize = 32_767;

fn is_numeric_type(type_name: &str) -> bool {
    const NUMERIC: [&str; 26] = [
        "int",
        "integer",
        "smallint",
        "tinyint",
        "mediumint",
        "bigint",
        "int2",
        "int4",
        "int8",
        "serial",
        "bigserial",
        "smallserial",
        "decimal",
        "numeric",
        "real",
        "float",
        "float4",
        "float8",
        "double",
        "money",
        "smallmoney",
        "number",
        "year",
        "oid",
        "dec",
        "fixed",
    ];
    let lower = type_name.trim().to_ascii_lowercase();
    let word = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .unwrap_or("");
    NUMERIC.contains(&word)
}

/// Whether Excel can hold `s` as a number without losing digits.
fn plain_number(s: &str) -> bool {
    let digits = s.bytes().filter(u8::is_ascii_digit).count();
    let shape = s
        .strip_prefix('-')
        .unwrap_or(s)
        .split_once('.')
        .map_or_else(
            || {
                s.strip_prefix('-')
                    .unwrap_or(s)
                    .bytes()
                    .all(|b| b.is_ascii_digit())
            },
            |(int, frac)| {
                !int.is_empty()
                    && !frac.is_empty()
                    && int.bytes().all(|b| b.is_ascii_digit())
                    && frac.bytes().all(|b| b.is_ascii_digit())
            },
        );
    !s.is_empty() && s != "-" && digits <= 15 && shape
}

fn xml_escape(s: &str, out: &mut String) {
    for (i, c) in s.chars().enumerate() {
        if i >= XLSX_MAX_CHARS {
            break;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 1.0 has no way to write other control characters
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

const WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Result" sheetId="1" r:id="rId1"/></sheets></workbook>"#;

const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

/// Style 1 is the bold header.
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>"#;

const SHEET_START: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>"#;

const SHEET_END: &str = "</sheetData></worksheet>";

/// A one-sheet workbook whose sheet is written row by row into the zip, so
/// memory stays flat however many rows arrive. Strings are inline (no shared
/// string table, which would have to be held until the end).
pub struct Xlsx<W: Write + Seek> {
    zip: Option<zip::ZipWriter<W>>,
    numeric: Vec<bool>,
    rows: u64,
    buf: String,
}

impl<W: Write + Seek> Xlsx<W> {
    pub fn new(out: W) -> std::io::Result<Self> {
        let mut zip = zip::ZipWriter::new(out);
        let options = SimpleFileOptions::default();
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", ROOT_RELS),
            ("xl/workbook.xml", WORKBOOK),
            ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
            ("xl/styles.xml", STYLES),
        ] {
            zip.start_file(name, options)
                .map_err(std::io::Error::other)?;
            zip.write_all(body.as_bytes())?;
        }
        zip.start_file("xl/worksheets/sheet1.xml", options)
            .map_err(std::io::Error::other)?;
        zip.write_all(SHEET_START.as_bytes())?;
        Ok(Self {
            zip: Some(zip),
            numeric: Vec::new(),
            rows: 0,
            buf: String::new(),
        })
    }

    fn write_buf(&mut self) -> std::io::Result<()> {
        let zip = self
            .zip
            .as_mut()
            .ok_or_else(|| std::io::Error::other("The workbook is already finished"))?;
        zip.write_all(self.buf.as_bytes())?;
        self.buf.clear();
        Ok(())
    }

    fn string_cell(&mut self, s: &str, style: Option<u8>) {
        self.buf.push_str("<c t=\"inlineStr\"");
        if let Some(style) = style {
            self.buf.push_str(&format!(" s=\"{style}\""));
        }
        self.buf.push_str("><is><t xml:space=\"preserve\">");
        xml_escape(s, &mut self.buf);
        self.buf.push_str("</t></is></c>");
    }

    pub fn header(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()> {
        self.numeric = columns
            .iter()
            .map(|c| is_numeric_type(&c.type_name))
            .collect();
        self.buf.push_str("<row>");
        for c in columns {
            self.string_cell(&c.name, Some(1));
        }
        self.buf.push_str("</row>");
        self.write_buf()
    }

    pub fn push(&mut self, row: &[Value]) -> std::io::Result<()> {
        if self.rows + 1 >= XLSX_MAX_ROWS {
            return Ok(());
        }
        self.rows += 1;
        self.buf.push_str("<row>");
        for (i, value) in row.iter().enumerate() {
            match value {
                Value::Null => self.buf.push_str("<c/>"),
                Value::Bool(b) => self.buf.push_str(if *b {
                    "<c t=\"b\"><v>1</v></c>"
                } else {
                    "<c t=\"b\"><v>0</v></c>"
                }),
                Value::String(s) if self.numeric.get(i) == Some(&true) && plain_number(s) => {
                    self.buf.push_str("<c><v>");
                    self.buf.push_str(s);
                    self.buf.push_str("</v></c>");
                }
                other => {
                    let s = text(other).into_owned();
                    self.string_cell(&s, None);
                }
            }
        }
        self.buf.push_str("</row>");
        // Batch small rows into fewer compressor calls
        if self.buf.len() > 1 << 15 {
            self.write_buf()?;
        }
        Ok(())
    }

    pub fn close(&mut self) -> std::io::Result<()> {
        if let Some(mut out) = self.finish_into()? {
            out.flush()?;
        }
        Ok(())
    }

    /// Ends the sheet and the archive, handing back the writer.
    fn finish_into(&mut self) -> std::io::Result<Option<W>> {
        if self.zip.is_none() {
            return Ok(None);
        }
        self.buf.push_str(SHEET_END);
        self.write_buf()?;
        let zip = self.zip.take().expect("checked above");
        Ok(Some(zip.finish().map_err(std::io::Error::other)?))
    }
}

impl<W: Write + Seek + Send> RowSink for Xlsx<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()> {
        self.header(columns)
    }

    fn row(&mut self, row: &[Value]) -> std::io::Result<()> {
        self.push(row)
    }

    fn finish(&mut self) -> std::io::Result<()> {
        self.close()
    }
}

/// Writes rows the frontend already holds as a workbook at `path`.
pub fn write_xlsx(path: &str, columns: &[ColumnMeta], rows: &[Vec<Value>]) -> std::io::Result<()> {
    let mut book = Xlsx::new(BufWriter::new(File::create(path)?))?;
    book.header(columns)?;
    for row in rows {
        book.push(row)?;
    }
    book.close()
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use serde_json::json;

    use super::*;

    fn columns() -> Vec<ColumnMeta> {
        vec![
            ColumnMeta {
                name: "id".into(),
                type_name: "int4".into(),
            },
            ColumnMeta {
                name: "note".into(),
                type_name: "text".into(),
            },
        ]
    }

    #[test]
    fn csv_quotes_like_the_grid() {
        let mut out = Vec::new();
        {
            let mut sink = Delimited::new(&mut out, b',');
            sink.begin(&columns()).unwrap();
            sink.row(&[json!("1"), json!("a, \"b\"")]).unwrap();
            sink.row(&[json!(null), json!(true)]).unwrap();
            sink.finish().unwrap();
        }
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "id,note\r\n1,\"a, \"\"b\"\"\"\r\n,true\r\n"
        );
    }

    #[test]
    fn json_is_an_array_of_objects() {
        let mut out = Vec::new();
        {
            let mut sink = Json::new(&mut out);
            sink.begin(&columns()).unwrap();
            sink.row(&[json!("1"), json!(null)]).unwrap();
            sink.row(&[json!("2"), json!("x")]).unwrap();
            sink.finish().unwrap();
        }
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            parsed,
            json!([{"id": "1", "note": null}, {"id": "2", "note": "x"}])
        );

        let mut empty = Vec::new();
        {
            let mut sink = Json::new(&mut empty);
            sink.begin(&columns()).unwrap();
            sink.finish().unwrap();
        }
        assert_eq!(serde_json::from_slice::<Value>(&empty).unwrap(), json!([]));
    }

    #[test]
    fn xlsx_holds_numbers_and_escaped_strings() {
        let mut book = Xlsx::new(Cursor::new(Vec::new())).unwrap();
        book.header(&columns()).unwrap();
        book.push(&[json!("42"), json!("<a & b>\u{1}")]).unwrap();
        book.push(&[json!("12345678901234567890"), json!(null)])
            .unwrap();
        let cursor = book.finish_into().unwrap().unwrap();

        let mut archive = zip::ZipArchive::new(Cursor::new(cursor.into_inner())).unwrap();
        let mut sheet = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut sheet)
            .unwrap();
        assert!(sheet.contains("<c><v>42</v></c>"));
        assert!(sheet.contains("&lt;a &amp; b&gt;</t>"));
        // Too many digits for a double stays text
        assert!(sheet.contains(">12345678901234567890</t>"));
        assert!(archive.by_name("xl/workbook.xml").is_ok());
    }

    #[test]
    fn numbers_excel_can_hold() {
        assert!(plain_number("-12.5"));
        assert!(plain_number("0"));
        assert!(!plain_number("1e5"));
        assert!(!plain_number("12."));
        assert!(!plain_number("-"));
        assert!(!plain_number("1234567890123456"));
        assert!(is_numeric_type("numeric(10,2)"));
        assert!(is_numeric_type("BIGINT UNSIGNED"));
        assert!(!is_numeric_type("text"));
    }
}
