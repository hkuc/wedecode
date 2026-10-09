import esprima from "esprima";
import escodegen from "escodegen";

interface ScopeContext {
  vars?: Record<string, any>;
  condVars?: Record<string, Map<number | null, any>>;
  funcs?: Record<string, any>;
  itemVar?: string;
  indexVar?: string;
}

interface WxmlNode {
  type: "element" | "text";
  tag?: string;
  attrs?: Record<string, string>;
  children?: WxmlNode[];
  text?: string;
}

function cleanExpr(exprNode: any, scope: ScopeContext = {}): string {
  if (!exprNode) return "";
  function walk(node: any): any {
    if (!node) return node;
    if (node.type === "Identifier") {
      if (node.name === "D") return node;
      if (scope.vars && scope.vars[node.name]) {
        return walk(scope.vars[node.name]);
      }
      if (scope.itemVar && node.name === scope.itemVar) {
        return { type: "Identifier", name: "item" };
      }
      if (scope.indexVar && node.name === scope.indexVar) {
        return { type: "Identifier", name: "index" };
      }
      return node;
    }
    if (node.type === "MemberExpression") {
      if (node.object.type === "Identifier" && node.object.name === "D") {
        return node.property;
      }
      return {
        ...node,
        object: walk(node.object),
        property: node.computed ? walk(node.property) : node.property,
      };
    }
    if (node.type === "CallExpression") {
      if (
        node.callee.type === "Identifier" &&
        (node.callee.name === "X" || node.callee.name === "Y")
      ) {
        return walk(node.arguments[0]);
      }
      return {
        ...node,
        callee: walk(node.callee),
        arguments: node.arguments.map(walk),
      };
    }
    if (node.type === "UnaryExpression") {
      return {
        ...node,
        argument: walk(node.argument),
      };
    }
    if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
      return {
        ...node,
        left: walk(node.left),
        right: walk(node.right),
      };
    }
    if (node.type === "ConditionalExpression") {
      return {
        ...node,
        test: walk(node.test),
        consequent: walk(node.consequent),
        alternate: walk(node.alternate),
      };
    }
    if (node.type === "ArrayExpression") {
      return {
        ...node,
        elements: node.elements.map(walk),
      };
    }
    if (node.type === "ObjectExpression") {
      return {
        ...node,
        properties: node.properties.map((p: any) => ({
          ...p,
          value: walk(p.value),
        })),
      };
    }
    return node;
  }
  const cleanedAst = walk(JSON.parse(JSON.stringify(exprNode)));
  const gen = escodegen.generate(cleanedAst, {
    format: {
      quotes: "single",
      indent: { style: "" },
      compact: true,
    },
  });
  return gen.replace(/;$/, "");
}

function flattenPlus(node: any): any[] {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [...flattenPlus(node.left), ...flattenPlus(node.right)];
  }
  return [node];
}

function toWxmlString(exprNode: any, scope: ScopeContext = {}): string {
  if (!exprNode) return "";
  if (exprNode.type === "Literal") {
    if (typeof exprNode.value === "boolean") return "{{" + exprNode.value + "}}";
    if (typeof exprNode.value === "number") return String(exprNode.value);
    return String(exprNode.value);
  }
  const parts = flattenPlus(exprNode);
  const hasDynamic = parts.some(
    (p: any) => p.type !== "Literal" || typeof p.value !== "string"
  );
  if (!hasDynamic) {
    return parts.map((p: any) => p.value).join("");
  }
  let result = "";
  for (const part of parts) {
    if (part.type === "Literal" && typeof part.value === "string") {
      result += part.value;
    } else {
      let dynamicPart = part;
      if (
        dynamicPart.type === "CallExpression" &&
        dynamicPart.callee.name === "Y"
      ) {
        dynamicPart = dynamicPart.arguments[0];
      }
      const cleaned = cleanExpr(dynamicPart, scope);
      result += "{{" + cleaned + "}}";
    }
  }
  return result;
}

function parseConditionChain(expr: any): Map<number | null, any> {
  const map = new Map<number | null, any>();
  function traverse(node: any) {
    if (!node) return;
    if (node.type === "ConditionalExpression") {
      if (node.consequent.type === "Literal") {
        map.set(node.consequent.value, node.test);
      }
      traverse(node.alternate);
    } else if (node.type === "Literal") {
      map.set(node.value, null);
    }
  }
  traverse(expr);
  return map;
}

function formatWxml(nodes: WxmlNode[], indent = ""): string {
  const voidElements = new Set([
    "image",
    "input",
    "slot",
    "icon",
    "switch",
    "progress",
    "radio",
    "checkbox",
  ]);
  let xml = "";
  for (const n of nodes) {
    if (n.type === "text") {
      if (n.text !== undefined && n.text !== "") {
        xml += indent + n.text + "\n";
      }
    } else if (n.type === "element" && n.tag) {
      const attrList = Object.entries(n.attrs || {})
        .map(([k, v]) => (v === "" ? k : `${k}="${v}"`))
        .join(" ");
      const openTag = attrList ? `<${n.tag} ${attrList}>` : `<${n.tag}>`;
      const closeTag = `</${n.tag}>`;

      if (!n.children || n.children.length === 0) {
        if (voidElements.has(n.tag)) {
          xml += indent + (attrList ? `<${n.tag} ${attrList} />` : `<${n.tag} />`) + "\n";
        } else {
          xml += indent + openTag + closeTag + "\n";
        }
      } else if (
        n.children.length === 1 &&
        n.children[0].type === "text" &&
        !n.children[0].text?.includes("\n")
      ) {
        xml += indent + (attrList ? `<${n.tag} ${attrList}>` : `<${n.tag}>`) + n.children[0].text + closeTag + "\n";
      } else {
        xml += indent + openTag + "\n";
        xml += formatWxml(n.children, indent + "  ");
        xml += indent + closeTag + "\n";
      }
    }
  }
  return xml;
}

export function decompileGlassEasel(fnSource: string): string {
  if (typeof fnSource !== "string" || !fnSource.trim()) return "";
  const ast = esprima.parseScript("var fn = " + fnSource) as any;
  const fnExpr = ast.body[0].declarations[0].init;
  const body = fnExpr.body.body || (fnExpr.body.type === "BlockStatement" ? fnExpr.body.body : [fnExpr.body]);

  const funcMap = new Map<string, any>();
  const condVarMap = new Map<string, Map<number | null, any>>();

  for (const stmt of body) {
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (decl.init) {
          if (decl.init.type === "ArrowFunctionExpression" || decl.init.type === "FunctionExpression") {
            funcMap.set(decl.id.name, decl.init);
          } else if (decl.init.type === "ConditionalExpression") {
            condVarMap.set(decl.id.name, parseConditionChain(decl.init));
          }
        }
      }
    } else if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression;
      function checkAssign(e: any) {
        if (e.type === "AssignmentExpression" && e.left.type === "Identifier") {
          if (e.right.type === "ArrowFunctionExpression" || e.right.type === "FunctionExpression") {
            funcMap.set(e.left.name, e.right);
          } else if (e.right.type === "ConditionalExpression") {
            condVarMap.set(e.left.name, parseConditionChain(e.right));
          }
        }
      }
      if (expr.type === "SequenceExpression") {
        expr.expressions.forEach(checkAssign);
      } else {
        checkAssign(expr);
      }
    }
  }

  const retStmt = body.slice().reverse().find((s: any) => s.type === "ReturnStatement");
  if (!retStmt || !retStmt.argument || !retStmt.argument.properties) return "";
  const rootProp = retStmt.argument.properties.find((p: any) => (p.key.name || p.key.value) === "C");
  const rootName = rootProp?.value?.name;
  if (!rootName) return "";

  function renderFunc(fnNode: any, scope: ScopeContext = {}): WxmlNode[] {
    const nodes: WxmlNode[] = [];
    if (!fnNode) return nodes;

    const fnBody = fnNode.body.body || (fnNode.body.type === "BlockStatement" ? fnNode.body.body : [fnNode.body]);
    const localScope: ScopeContext = {
      ...scope,
      vars: { ...(scope.vars || {}) },
      condVars: { ...(scope.condVars || {}) },
      funcs: { ...(scope.funcs || {}) },
    };

    // Extract local declarations
    for (const s of (Array.isArray(fnBody) ? fnBody : [fnBody])) {
      if (s.type === "VariableDeclaration") {
        for (const d of s.declarations) {
          if (d.init) {
            if (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression") {
              localScope.funcs![d.id.name] = d.init;
            } else {
              localScope.vars![d.id.name] = d.init;
              if (d.init.type === "ConditionalExpression") {
                localScope.condVars![d.id.name] = parseConditionChain(d.init);
              }
            }
          }
        }
      } else if (s.type === "ExpressionStatement") {
        function checkExpr(e: any) {
          if (e.type === "AssignmentExpression" && e.left.type === "Identifier") {
            if (e.right.type === "ArrowFunctionExpression" || e.right.type === "FunctionExpression") {
              localScope.funcs![e.left.name] = e.right;
            } else if (e.right.type === "ConditionalExpression") {
              localScope.condVars![e.left.name] = parseConditionChain(e.right);
            } else {
              localScope.vars![e.left.name] = e.right;
            }
          }
        }
        if (s.expression.type === "SequenceExpression") {
          s.expression.expressions.forEach(checkExpr);
        } else {
          checkExpr(s.expression);
        }
      }
    }

    // Process statements
    for (const s of (Array.isArray(fnBody) ? fnBody : [fnBody])) {
      function processStmt(stmt: any) {
        if (!stmt) return;
        if (stmt.type === "ExpressionStatement") {
          processExpr(stmt.expression);
        }
      }

      function processExpr(expr: any) {
        if (!expr) return;
        if (expr.type === "SequenceExpression") {
          expr.expressions.forEach(processExpr);
          return;
        }
        if (expr.type === "AssignmentExpression") {
          if (expr.right.type === "ConditionalExpression") {
            localScope.condVars![expr.left.name] = parseConditionChain(expr.right);
          }
          return;
        }
        if (expr.type === "ConditionalExpression") {
          if (expr.consequent.type === "CallExpression" && expr.consequent.callee.name === "T") {
            const textArg = expr.consequent.arguments[0];
            if (textArg) {
              let unwrap = textArg;
              if (unwrap.type === "CallExpression" && unwrap.callee.name === "Y") unwrap = unwrap.arguments[0];
              const textVal = toWxmlString(unwrap, localScope);
              if (textVal) {
                nodes.push({
                  type: "text",
                  text: textVal.startsWith("{{") ? textVal : (textArg.type === "Literal" ? textVal : "{{" + cleanExpr(unwrap, localScope) + "}}")
                });
              }
            }
          }
          return;
        }
        if (expr.type === "CallExpression") {
          const callee = expr.callee;
          if (callee.type === "Identifier") {
            if (callee.name === "E") {
              const tag = expr.arguments[0].value;
              const attrFnArg = expr.arguments[2];
              const childFnArg = expr.arguments[3];
              const slotNameArg = expr.arguments[4];

              const attrs: Record<string, string> = {};
              if (slotNameArg && slotNameArg.value) {
                attrs["slot"] = slotNameArg.value;
              }

              // Parse attributes
              const attrFn = attrFnArg?.type === "Identifier" ? (localScope.funcs![attrFnArg.name] || funcMap.get(attrFnArg.name)) : attrFnArg;
              if (attrFn) {
                parseAttrFn(attrFn, attrs, localScope);
              }

              // Parse children
              const childFn = childFnArg?.type === "Identifier" ? (localScope.funcs![childFnArg.name] || funcMap.get(childFnArg.name)) : childFnArg;
              let children: WxmlNode[] = [];
              if (childFn) {
                children = renderFunc(childFn, localScope);
              }

              nodes.push({ type: "element", tag, attrs, children });
            } else if (callee.name === "B") {
              const condVar = expr.arguments[0].name;
              const branchFnArg = expr.arguments[1];
              const branchFn = branchFnArg?.type === "Identifier" ? (localScope.funcs![branchFnArg.name] || funcMap.get(branchFnArg.name)) : branchFnArg;
              const conditions = localScope.condVars![condVar] || condVarMap.get(condVar);

              if (branchFn && conditions) {
                const branchNodes = renderBranch(branchFn, conditions, condVar, localScope);
                nodes.push(...branchNodes);
              }
            } else if (callee.name === "F") {
              const arrExpr = expr.arguments[0];
              const keyExpr = expr.arguments[1];
              const itemFnArg = expr.arguments[4];
              const itemFn = itemFnArg?.type === "Identifier" ? (localScope.funcs![itemFnArg.name] || funcMap.get(itemFnArg.name)) : itemFnArg;

              if (itemFn) {
                const itemVar = itemFn.params[1]?.name;
                const indexVar = itemFn.params[2]?.name;
                const loopScope: ScopeContext = {
                  ...localScope,
                  itemVar,
                  indexVar,
                };
                const loopChildren = renderFunc(itemFn, loopScope);
                const arrClean = cleanExpr(arrExpr, localScope);
                const keyVal = keyExpr?.type === "Literal" ? keyExpr.value : (keyExpr ? cleanExpr(keyExpr, localScope) : "");

                if (loopChildren.length === 1 && loopChildren[0].type === "element") {
                  const el = loopChildren[0];
                  el.attrs = el.attrs || {};
                  el.attrs["wx:for"] = "{{" + arrClean + "}}";
                  if (keyVal) el.attrs["wx:key"] = keyVal;
                  nodes.push(el);
                } else {
                  nodes.push({
                    type: "element",
                    tag: "block",
                    attrs: {
                      "wx:for": "{{" + arrClean + "}}",
                      ...(keyVal ? { "wx:key": keyVal } : {})
                    },
                    children: loopChildren
                  });
                }
              }
            } else if (callee.name === "S") {
              const slotName = expr.arguments[0]?.value || "";
              nodes.push({
                type: "element",
                tag: "slot",
                attrs: slotName ? { name: slotName } : {},
                children: []
              });
            } else if (callee.name === "T") {
              const textArg = expr.arguments[0];
              if (textArg) {
                let unwrap = textArg;
                if (unwrap.type === "CallExpression" && unwrap.callee.name === "Y") unwrap = unwrap.arguments[0];
                const textVal = toWxmlString(unwrap, localScope);
                if (textVal) {
                  nodes.push({ type: "text", text: textVal });
                }
              }
            }
          }
        }
      }

      processStmt(s);
    }

    return nodes;
  }

  function parseAttrFn(attrFnNode: any, attrs: Record<string, string>, scope: ScopeContext) {
    const fnBody = attrFnNode.body.body || (attrFnNode.body.type === "BlockStatement" ? attrFnNode.body.body : [attrFnNode.body]);
    const attrScope: ScopeContext = { ...scope, vars: { ...(scope.vars || {}) } };

    for (const s of (Array.isArray(fnBody) ? fnBody : [fnBody])) {
      if (s.type === "VariableDeclaration") {
        for (const d of s.declarations) {
          if (d.init) attrScope.vars![d.id.name] = d.init;
        }
      }
      function walkAttrStmt(stmt: any) {
        if (!stmt) return;
        if (stmt.type === "IfStatement") {
          walkAttrStmt(stmt.consequent);
        } else if (stmt.type === "BlockStatement") {
          stmt.body.forEach(walkAttrStmt);
        } else if (stmt.type === "ExpressionStatement") {
          const expr = stmt.expression;
          const exprList = expr.type === "SequenceExpression" ? expr.expressions : [expr];
          for (const e of exprList) {
            if (e.type === "AssignmentExpression" && e.left.type === "Identifier") {
              attrScope.vars![e.left.name] = e.right;
            } else if (e.type === "CallExpression") {
              const c = e.callee;
              if (c.type === "Identifier") {
                if (c.name === "L") {
                  attrs["class"] = toWxmlString(e.arguments[1], attrScope);
                } else if (c.name === "O") {
                  const attrName = e.arguments[1].value;
                  const attrExpr = e.arguments[2];
                  if (attrName.startsWith("bind") || attrName.startsWith("catch")) {
                    attrs[attrName] = attrExpr.type === "Literal" ? String(attrExpr.value) : cleanExpr(attrExpr, attrScope);
                  } else if (attrExpr.type === "Literal") {
                    if (typeof attrExpr.value === "boolean") attrs[attrName] = "{{" + attrExpr.value + "}}";
                    else attrs[attrName] = String(attrExpr.value);
                  } else {
                    attrs[attrName] = "{{" + cleanExpr(attrExpr, attrScope) + "}}";
                  }
                }
              } else if (c.type === "MemberExpression") {
                const method = c.property.name;
                if (method === "d") {
                  const key = e.arguments[1].value;
                  const valExpr = e.arguments[2];
                  attrs["data-" + key] = valExpr.type === "Literal" ? String(valExpr.value) : "{{" + cleanExpr(valExpr, attrScope) + "}}";
                } else if (method === "y") {
                  attrs["style"] = toWxmlString(e.arguments[1], attrScope);
                } else if (method === "v") {
                  const eventName = e.arguments[1].value;
                  const handlerName = e.arguments[2].value;
                  attrs["bind:" + eventName] = handlerName;
                } else if (method === "i") {
                  const idExpr = e.arguments[1];
                  attrs["id"] = idExpr.type === "Literal" ? String(idExpr.value) : "{{" + cleanExpr(idExpr, attrScope) + "}}";
                }
              }
            }
          }
        }
      }
      walkAttrStmt(s);
    }
  }

  function renderBranch(branchFnNode: any, conditions: Map<number | null, any>, condVar: string, scope: ScopeContext): WxmlNode[] {
    const resultNodes: WxmlNode[] = [];
    const fnBody = branchFnNode.body.body || (branchFnNode.body.type === "BlockStatement" ? branchFnNode.body.body : [branchFnNode.body]);
    const ifStmt = (Array.isArray(fnBody) ? fnBody : [fnBody]).find((s: any) => s.type === "IfStatement");
    if (!ifStmt) return resultNodes;

    let curr = ifStmt;
    let isFirst = true;

    while (curr) {
      let condExprAst = null;
      if (curr.test) {
        const branchIndex = curr.test.right ? curr.test.right.value : 1;
        condExprAst = conditions.get(branchIndex);
      }
      const condExprStr = condExprAst ? cleanExpr(condExprAst, scope) : null;

      // Render consequent
      const consequentNodes: WxmlNode[] = [];
      const cBody = curr.consequent.type === "BlockStatement" ? curr.consequent.body : [curr.consequent];
      for (const s of cBody) {
        const fakeFn = { body: { body: [s] } };
        consequentNodes.push(...renderFunc(fakeFn, scope));
      }

      // Attach wx:if / wx:elif / wx:else
      if (consequentNodes.length === 1 && consequentNodes[0].type === "element") {
        const el = consequentNodes[0];
        el.attrs = el.attrs || {};
        if (condExprStr) {
          el.attrs[isFirst ? "wx:if" : "wx:elif"] = "{{" + condExprStr + "}}";
        } else {
          el.attrs["wx:else"] = "";
        }
        resultNodes.push(el);
      } else if (consequentNodes.length > 0) {
        resultNodes.push({
          type: "element",
          tag: "block",
          attrs: condExprStr ? { [isFirst ? "wx:if" : "wx:elif"]: "{{" + condExprStr + "}}" } : { "wx:else": "" },
          children: consequentNodes
        });
      }

      isFirst = false;
      if (curr.alternate) {
        if (curr.alternate.type === "IfStatement") {
          curr = curr.alternate;
        } else {
          // Final else
          const elseNodes: WxmlNode[] = [];
          const eBody = curr.alternate.type === "BlockStatement" ? curr.alternate.body : [curr.alternate];
          for (const s of eBody) {
            const fakeFn = { body: { body: [s] } };
            elseNodes.push(...renderFunc(fakeFn, scope));
          }
          if (elseNodes.length === 1 && elseNodes[0].type === "element") {
            const el = elseNodes[0];
            el.attrs = el.attrs || {};
            el.attrs["wx:else"] = "";
            resultNodes.push(el);
          } else if (elseNodes.length > 0) {
            resultNodes.push({
              type: "element",
              tag: "block",
              attrs: { "wx:else": "" },
              children: elseNodes
            });
          }
          break;
        }
      } else {
        break;
      }
    }

    return resultNodes;
  }

  const rootFn = funcMap.get(rootName);
  if (!rootFn) return "";
  const rootNodes = renderFunc(rootFn);
  return formatWxml(rootNodes);
}
