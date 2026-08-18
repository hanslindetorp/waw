// Line-by-line XML tokenizer for the source-view syntax highlighting overlay.
// Ported from the XML-editor-DEMO Lovable prototype (src/components/XmlCodeEditor.tsx).
// Returns { type, text }[][] — one token array per line.

export function tokenizeXml(code) {
	const lines = code.split("\n");
	return lines.map((line) => {
		const tokens = [];
		let i = 0;

		while (i < line.length) {
			if (line.startsWith("<!--", i)) {
				const end = line.indexOf("-->", i);
				if (end !== -1) {
					tokens.push({ type: "comment", text: line.slice(i, end + 3) });
					i = end + 3;
				} else {
					tokens.push({ type: "comment", text: line.slice(i) });
					i = line.length;
				}
			} else if (line.startsWith("<?", i)) {
				const end = line.indexOf("?>", i);
				if (end !== -1) {
					tokens.push({ type: "comment", text: line.slice(i, end + 2) });
					i = end + 2;
				} else {
					tokens.push({ type: "comment", text: line.slice(i) });
					i = line.length;
				}
			} else if (line.startsWith("</", i)) {
				tokens.push({ type: "bracket", text: "</" });
				i += 2;
				const tagEnd = line.indexOf(">", i);
				if (tagEnd !== -1) {
					tokens.push({ type: "tag", text: line.slice(i, tagEnd) });
					tokens.push({ type: "bracket", text: ">" });
					i = tagEnd + 1;
				}
			} else if (line[i] === "<" && line[i + 1] !== "/") {
				tokens.push({ type: "bracket", text: "<" });
				i += 1;

				let tagName = "";
				while (i < line.length && !/[\s/>]/.test(line[i])) {
					tagName += line[i];
					i++;
				}
				if (tagName) tokens.push({ type: "tag", text: tagName });

				while (i < line.length && line[i] !== ">" && !(line[i] === "/" && line[i + 1] === ">")) {
					if (/\s/.test(line[i])) {
						tokens.push({ type: "text", text: line[i] });
						i++;
						continue;
					}
					let attrName = "";
					while (i < line.length && line[i] !== "=" && !/[\s/>]/.test(line[i])) {
						attrName += line[i];
						i++;
					}
					if (attrName) tokens.push({ type: "attr-name", text: attrName });

					if (line[i] === "=") {
						tokens.push({ type: "bracket", text: "=" });
						i++;
						if (line[i] === '"' || line[i] === "'") {
							const quote = line[i];
							let val = quote;
							i++;
							while (i < line.length && line[i] !== quote) {
								val += line[i];
								i++;
							}
							if (i < line.length) {
								val += line[i];
								i++;
							}
							tokens.push({ type: "attr-value", text: val });
						}
					}
				}

				if (line[i] === "/" && line[i + 1] === ">") {
					tokens.push({ type: "bracket", text: "/>" });
					i += 2;
				} else if (line[i] === ">") {
					tokens.push({ type: "bracket", text: ">" });
					i += 1;
				}
			} else {
				let text = "";
				while (i < line.length && line[i] !== "<") {
					text += line[i];
					i++;
				}
				if (text) tokens.push({ type: "text", text });
			}
		}

		return tokens;
	});
}
