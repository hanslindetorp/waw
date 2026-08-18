// XSD schema parser -> ParsedSchema = { rootElements: string[], elements: {name: SchemaElement} }
// SchemaElement = { name, allowedChildren: string[], allowedAttributes: SchemaAttribute[], allowsText: boolean, allowsAnyAttribute: boolean }
// allowsAnyAttribute is true when the complexType declares <xs:anyAttribute>
// (a wildcard alongside its fixed attribute list) — the UI uses it to decide
// whether to also offer a free-form "add attribute" row for names the schema
// itself doesn't enumerate.
// SchemaAttribute = { name, type: "string"|"number"|"boolean"|"enum"|"union", required, enumValues?, minValue?, maxValue?, defaultValue?, pattern?, unionMembers? }
// A "union" attribute (xs:union of several otherwise-unrelated value shapes —
// e.g. a number OR one of a fixed set of keywords OR a free-form
// pattern-matched string) carries no type/enumValues/etc of its own; instead
// unionMembers is a list of the same {type, enumValues?, minValue?, ...}
// shape, one per member type, for the UI to offer as separate input modes.
//
// Ported from the XML-editor-DEMO Lovable prototype (src/lib/schema-utils.ts),
// prefix-independent (works with xs:, xsd: or no prefix) via Element.localName.
//
// Extended beyond the DEMO: the real WAXML schema wraps every primitive in a
// named simpleType for documentation (e.g. `gain` -> restriction base="xs:string",
// `loop` -> restriction base="xs:boolean") instead of using xs:boolean/xs:decimal
// directly on the attribute. The DEMO's parser only looked at the attribute's own
// `type="..."` string, so every such attribute fell back to a plain text box —
// resolveTypeChain() below follows named-type references to their ultimate base
// type (and picks up enum/pattern/min/max facets along the way) so e.g. `loop`
// renders as a real checkbox.

export function parseXsdSchema(xsdString) {
	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(xsdString, "application/xml");
		if (doc.querySelector("parsererror")) return null;

		const schema = { rootElements: [], elements: {} };
		const root = doc.documentElement;

		const globalElements = {};
		const namedTypes = {};
		const namedGroups = {};
		const namedAttrGroups = {};
		const namedSimpleTypes = {};

		for (const child of Array.from(root.children)) {
			const ln = child.localName;
			const name = child.getAttribute("name");
			if (!name) continue;
			if (ln === "element") globalElements[name] = child;
			else if (ln === "complexType") namedTypes[name] = child;
			else if (ln === "group") namedGroups[name] = child;
			else if (ln === "attributeGroup") namedAttrGroups[name] = child;
			else if (ln === "simpleType") namedSimpleTypes[name] = child;
		}

		const ctx = { globalElements, namedTypes, namedGroups, namedAttrGroups, namedSimpleTypes };

		for (const name of Object.keys(globalElements)) {
			schema.rootElements.push(name);
		}

		for (const [name, el] of Object.entries(globalElements)) {
			processElement(name, el, schema, ctx);
		}

		return schema;
	} catch (e) {
		console.error("Schema parse error:", e);
		return null;
	}
}

function processElement(name, el, schema, ctx) {
	if (schema.elements[name]) return;

	// allowsText defaults to true: an element with no resolvable complexType
	// (e.g. declared with a plain simple type, type="xs:string") has nothing
	// *but* text, so it should stay permissive. Once a complexType IS found,
	// XSD's own rule takes over: text is only allowed if the type is
	// mixed="true" or built from <simpleContent> — a plain element/attribute
	// content model does not allow character data at all.
	const schemaEl = { name, allowedChildren: [], allowedAttributes: [], allowsText: true, allowsAnyAttribute: false };
	// Reserve the slot to prevent infinite recursion on circular schemas.
	schema.elements[name] = schemaEl;

	const complexType = resolveComplexType(el, ctx.namedTypes);
	if (complexType) {
		collectChildElements(complexType, schemaEl, schema, ctx);
		collectAttributes(complexType, schemaEl, ctx);
		schemaEl.allowsText = complexTypeAllowsText(complexType);
	}
}

function complexTypeAllowsText(complexType) {
	if (complexType.getAttribute("mixed") === "true") return true;
	for (const child of Array.from(complexType.children)) {
		if (child.localName === "simpleContent") return true;
	}
	return false;
}

function resolveComplexType(el, namedTypes) {
	const typeName = el.getAttribute("type");
	if (typeName) {
		const localType = stripPrefix(typeName);
		if (namedTypes[localType]) return namedTypes[localType];
	}
	for (const child of Array.from(el.children)) {
		if (child.localName === "complexType") return child;
	}
	return null;
}

function stripPrefix(name) {
	return name.includes(":") ? name.split(":").pop() : name;
}

function collectChildElements(container, schemaEl, schema, ctx) {
	for (const child of Array.from(container.children)) {
		const ln = child.localName;

		if (ln === "sequence" || ln === "choice" || ln === "all") {
			collectChildElements(child, schemaEl, schema, ctx);
		} else if (ln === "group") {
			const ref = child.getAttribute("ref");
			if (ref) {
				const groupDef = ctx.namedGroups[stripPrefix(ref)];
				if (groupDef) collectChildElements(groupDef, schemaEl, schema, ctx);
			} else {
				collectChildElements(child, schemaEl, schema, ctx);
			}
		} else if (ln === "element") {
			const ref = child.getAttribute("ref");
			const elName = child.getAttribute("name");

			if (ref) {
				const localRef = stripPrefix(ref);
				if (!schemaEl.allowedChildren.includes(localRef)) {
					schemaEl.allowedChildren.push(localRef);
				}
				if (ctx.globalElements[localRef]) {
					processElement(localRef, ctx.globalElements[localRef], schema, ctx);
				}
			} else if (elName) {
				if (!schemaEl.allowedChildren.includes(elName)) {
					schemaEl.allowedChildren.push(elName);
				}
				processElement(elName, child, schema, ctx);
			}
		} else if (ln === "complexContent" || ln === "simpleContent") {
			for (const sub of Array.from(child.children)) {
				if (sub.localName === "extension" || sub.localName === "restriction") {
					const base = sub.getAttribute("base");
					if (base) {
						const localBase = stripPrefix(base);
						if (ctx.namedTypes[localBase]) {
							collectChildElements(ctx.namedTypes[localBase], schemaEl, schema, ctx);
						}
					}
					collectChildElements(sub, schemaEl, schema, ctx);
				}
			}
		}
	}
}

function collectAttributes(complexType, schemaEl, ctx) {
	walkForAttributes(complexType, schemaEl, ctx);
}

function walkForAttributes(el, schemaEl, ctx) {
	for (const child of Array.from(el.children)) {
		const ln = child.localName;
		if (ln === "attribute") {
			const attrName = child.getAttribute("name");
			if (attrName && !schemaEl.allowedAttributes.some((a) => a.name === attrName)) {
				schemaEl.allowedAttributes.push(parseAttributeDecl(child, ctx.namedSimpleTypes));
			}
		} else if (ln === "attributeGroup") {
			const ref = child.getAttribute("ref");
			if (ref) {
				const groupDef = ctx.namedAttrGroups[stripPrefix(ref)];
				if (groupDef) walkForAttributes(groupDef, schemaEl, ctx);
			} else {
				walkForAttributes(child, schemaEl, ctx);
			}
		} else if (ln === "anyAttribute") {
			schemaEl.allowsAnyAttribute = true;
		} else if (ln === "simpleContent" || ln === "complexContent" || ln === "extension" || ln === "restriction") {
			walkForAttributes(child, schemaEl, ctx);
		}
	}
}

// Follows a chain of named-simpleType references (type="foo" -> <simpleType name="foo">
// <restriction base="bar">, possibly repeated) down to the ultimate built-in base type
// (e.g. "xs:boolean"), collecting every restriction element visited along the way
// (most specific/closest first) so its facets (enum/pattern/min/max) can still apply.
function resolveTypeChain(typeRef, namedSimpleTypes) {
	const restrictions = [];
	let current = typeRef;
	const visited = new Set();

	while (current) {
		const localType = stripPrefix(current);
		if (visited.has(localType)) break;
		visited.add(localType);
		const namedType = namedSimpleTypes[localType];
		if (!namedType) break; // current is a built-in type (xs:string, xs:boolean, ...) or unresolvable
		// :scope > restriction, not a bare descendant search — a named type
		// that's actually a <union> (see below) can have a <restriction>
		// buried inside one of its member types, which is a different thing
		// entirely and must not be picked up here.
		const restriction = namedType.querySelector(":scope > restriction");
		if (!restriction) break;
		restrictions.push(restriction);
		current = restriction.getAttribute("base") || "";
	}

	return { baseKeyword: current || typeRef, restrictions };
}

// A <union memberTypes="..."> element's member types can be named (via the
// memberTypes attribute, built-in like xs:decimal or referencing another
// named simpleType) and/or inline anonymous <simpleType> children — resolves
// each into the same {type, enumValues?, minValue?, ...} shape used for a
// plain (non-union) attribute.
function resolveUnionMembers(unionEl, namedSimpleTypes) {
	const members = [];

	const memberTypesAttr = unionEl.getAttribute("memberTypes");
	if (memberTypesAttr) {
		memberTypesAttr
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.forEach((ref) => members.push(resolveTypeDescriptor(ref, namedSimpleTypes)));
	}

	for (const child of Array.from(unionEl.children)) {
		if (child.localName === "simpleType") members.push(resolveTypeDescriptor(child, namedSimpleTypes));
	}

	return members;
}

// Resolves one type shape, starting from either a type-ref string (e.g.
// "xs:decimal" or a named simpleType's name) or an inline anonymous
// <simpleType> element — shared between a plain attribute's own type and
// each member of a <union>. A member that is itself a union (nested unions)
// flattens into the parent's member list rather than nesting, since the UI
// only offers one flat set of mode tabs.
function resolveTypeDescriptor(typeRefOrInlineEl, namedSimpleTypes) {
	const descriptor = { type: "string" };

	if (typeof typeRefOrInlineEl === "string") {
		const namedUnion = findNamedUnion(typeRefOrInlineEl, namedSimpleTypes);
		if (namedUnion) return { type: "union", unionMembers: resolveUnionMembers(namedUnion, namedSimpleTypes) };

		const { baseKeyword, restrictions } = resolveTypeChain(typeRefOrInlineEl, namedSimpleTypes);
		applyBaseKeyword(descriptor, baseKeyword);
		applyFacets(descriptor, restrictions);
		return descriptor;
	}

	const inlineUnion = typeRefOrInlineEl?.querySelector(":scope > union");
	if (inlineUnion) return { type: "union", unionMembers: resolveUnionMembers(inlineUnion, namedSimpleTypes) };

	const inlineRestriction = typeRefOrInlineEl?.querySelector(":scope > restriction");
	if (inlineRestriction) {
		const base = inlineRestriction.getAttribute("base") || "";
		const { baseKeyword, restrictions } = resolveTypeChain(base, namedSimpleTypes);
		applyBaseKeyword(descriptor, baseKeyword);
		applyFacets(descriptor, [inlineRestriction, ...restrictions]);
	}
	return descriptor;
}

function findNamedUnion(typeRef, namedSimpleTypes) {
	const namedType = namedSimpleTypes[stripPrefix(typeRef)];
	return namedType ? namedType.querySelector(":scope > union") : null;
}

function parseAttributeDecl(attr, namedSimpleTypes) {
	const name = attr.getAttribute("name") || "unknown";
	const typeRef = attr.getAttribute("type") || "";
	const use = attr.getAttribute("use");
	const defaultVal = attr.getAttribute("default") || undefined;

	const schemaAttr = {
		name,
		type: "string",
		required: use === "required",
		defaultValue: defaultVal
	};

	const inlineSimpleType = attr.querySelector(":scope > simpleType");
	const unionEl = inlineSimpleType?.querySelector(":scope > union") || findNamedUnion(typeRef, namedSimpleTypes);
	if (unionEl) {
		schemaAttr.type = "union";
		schemaAttr.unionMembers = resolveUnionMembers(unionEl, namedSimpleTypes);
		return schemaAttr;
	}

	const { baseKeyword, restrictions } = resolveTypeChain(typeRef, namedSimpleTypes);
	applyBaseKeyword(schemaAttr, baseKeyword);

	const inlineRestriction = inlineSimpleType?.querySelector(":scope > restriction");
	const allRestrictions = inlineRestriction ? [inlineRestriction, ...restrictions] : restrictions;
	applyFacets(schemaAttr, allRestrictions);

	return schemaAttr;
}

function applyBaseKeyword(schemaAttr, type) {
	if (type.includes("integer") || type.includes("int") || type.includes("decimal") || type.includes("float") || type.includes("double")) {
		schemaAttr.type = "number";
		schemaAttr.minValue = 0;
		schemaAttr.maxValue = 100;
	} else if (type.includes("boolean")) {
		schemaAttr.type = "boolean";
	}
}

// Applies enum/pattern/min/max facets from a most-specific-first list of
// <restriction> elements; the first restriction that carries a given facet wins.
function applyFacets(schemaAttr, restrictions) {
	for (const restriction of restrictions) {
		if (!schemaAttr.enumValues) {
			const enums = restriction.querySelectorAll(":scope > enumeration");
			if (enums.length > 0) {
				schemaAttr.type = "enum";
				schemaAttr.enumValues = Array.from(enums).map((e) => e.getAttribute("value") || "");
			}
		}

		if (!schemaAttr.pattern) {
			const patternEl = restriction.querySelector(":scope > pattern");
			const patternValue = patternEl?.getAttribute("value");
			if (patternValue) schemaAttr.pattern = patternValue;
		}

		if (schemaAttr.minValue === undefined) {
			const minInclusive = restriction.querySelector(":scope > minInclusive");
			if (minInclusive) {
				schemaAttr.type = "number";
				schemaAttr.minValue = parseFloat(minInclusive.getAttribute("value") || "0");
			}
		}

		if (schemaAttr.maxValue === undefined) {
			const maxInclusive = restriction.querySelector(":scope > maxInclusive");
			if (maxInclusive) {
				schemaAttr.type = "number";
				schemaAttr.maxValue = parseFloat(maxInclusive.getAttribute("value") || "100");
			}
		}
	}
}
