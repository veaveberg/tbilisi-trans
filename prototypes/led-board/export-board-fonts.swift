// Run from repository root:
// swift -module-cache-path /tmp/ttc-font-cache prototypes/led-board/export-board-fonts.swift
// Samples filled outline cells, never rasterized text or antialiasing.
import Foundation
import CoreText
import CoreGraphics
import CryptoKit

struct BitmapGlyph: Codable {
    let advance: Int
    let x: Int
    let y: Int
    let width: Int
    let rows: [Int]
}
struct BitmapFace: Codable {
    let source: String
    let sha256: String
    let postscriptName: String
    let originalCSSSize: Int
    let glyphs: [String: BitmapGlyph]
}
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let candidates = Array(0x20...0xff) + Array(0x400...0x4ff) + Array(0x10a0...0x10ff) + Array(0x1c90...0x1cbf) + [0x2013,0x2014,0x2018,0x2019,0x2026,0x2d00,0x2d25]
var faces: [String: BitmapFace] = [:]
for (key,file,size,xSample) in [
    ("matrix","public/fonts/MatrixSansPrint-Regular.ttf",10.0,1.0),
    ("numeric","src/assets/fonts/5x7-matrix.otf",7.0,0.5)
] {
    let url = root.appendingPathComponent(file)
    let data = try Data(contentsOf: url)
    guard let provider = CGDataProvider(data: data as CFData), let graphicsFont = CGFont(provider) else {
        fatalError("Cannot open \(file)")
    }
    let font = CTFontCreateWithGraphicsFont(graphicsFont, CGFloat(size), nil, nil)
    var glyphs: [String: BitmapGlyph] = [:]
    for codepoint in candidates {
        guard let scalar = UnicodeScalar(codepoint) else { continue }
        var character = UniChar(codepoint), glyph: CGGlyph = 0
        guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1) else { continue }
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
        let cellAdvance = Int(advance.width.rounded())
        precondition(abs(advance.width-CGFloat(cellAdvance)) < 0.03, "Non-grid advance for \(scalar)")
        var points: [(Int,Int)] = []
        if let path = CTFontCreatePathForGlyph(font, glyph, nil) {
            // Both originals have seven illuminated rows above their baseline.
            // Keep descenders and punctuation in their original relative cells.
            for row in -3...10 {
                for column in -2...(cellAdvance+2) {
                    if path.contains(CGPoint(x: CGFloat(column)+xSample, y: 6.5-CGFloat(row))) {
                        points.append((column,row))
                    }
                }
            }
        }
        let left = points.map(\.0).min() ?? 0, right = points.map(\.0).max() ?? -1
        let top = points.map(\.1).min() ?? 0, bottom = points.map(\.1).max() ?? -1
        let width = max(0,right-left+1)
        var rows = Array(repeating: 0, count: max(0,bottom-top+1))
        for (x,y) in points { rows[y-top] |= 1 << (width-1-(x-left)) }
        glyphs[String(scalar)] = BitmapGlyph(advance: cellAdvance, x: left, y: top, width: width, rows: rows)
    }
    faces[key] = BitmapFace(source: file, sha256: SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined(), postscriptName: CTFontCopyPostScriptName(font) as String, originalCSSSize: Int(size*2), glyphs: glyphs)
    print("\(key): \(glyphs.count) glyphs, \(CTFontCopyPostScriptName(font))")
}
for c in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" {
    precondition(faces["numeric"]!.glyphs[String(c)] != nil)
}
for c in "თავისუფლებისმოედანიᲗᲐᲕᲘᲡᲣᲤᲚᲔᲑᲘᲡ°" {
    precondition(faces["matrix"]!.glyphs[String(c)] != nil)
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let output = try encoder.encode(faces)
try output.write(to: root.appendingPathComponent("prototypes/led-board/assets/original-board-fonts.json"))

try output.write(to: root.appendingPathComponent("src/assets/fonts/board-pixels.json"))
