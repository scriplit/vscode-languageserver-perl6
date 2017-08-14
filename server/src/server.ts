/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind
} from 'vscode-languageserver';

import Uri from 'vscode-uri';
import tmp = require('tmp');
import fs = require('fs');


// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities. 
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support code complete
			completionProvider: {
				resolveProvider: true
			}
		}
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

// The settings interface describe the server relevant settings part
interface Settings {
	languageServerPerl6: Perl6Settings;
}

// These are the settings we defined in the client's package.json
interface Perl6Settings {
	maxNumberOfProblems: number;
}

// hold the maxNumberOfProblems setting
let maxNumberOfProblems: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	maxNumberOfProblems = settings.languageServerPerl6.maxNumberOfProblems || 100;
	// Revalidate any open text documents
	documents.all().forEach(validateTextDocument);
});

function parse_undeclared(type: string, lines: string, diagnostics: Diagnostic[]) {
	let next_lines = lines.split(/\r?\n/g);
	for (let line of next_lines) {
		let m2 = /^\s+(\S+) used at line (\d+)(.*)$/.exec(line);
		if (m2) {
			let name = m2[1];
			let line_num = +m2[2] - 1;
			let advice = m2[3];

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: {
					start: { line: line_num, character: 0 },
					end: { line: line_num, character: 1000 }
				},
				message: type + ' ' + name + ' is not declared' + advice,
				source: 'perl6'
			});
		}
		else {
			break;
		}
	}
}

function parse_missing_libs(m: RegExpExecArray, diagnostics: Diagnostic[]) {
	let missing_lib = m[1];
	let line_num = +m[2] - 1;
	let lib_paths = m[3];
	diagnostics.push({
		severity: DiagnosticSeverity.Error,
		range: {
			start: { line: line_num, character: 0 },
			end: { line: line_num, character: 1000 }
		},
		message: 'Could not find ' + missing_lib + ' in:\n' + lib_paths,
		source: 'perl6'
	});
}

function parse_generic_single(msg: string, diagnostics: Diagnostic[]) {
	let m = /(.*)\r?\nat .*?:(\d+)\r?\n------> (.*)/.exec(msg);
	let finding = m[1];
	let line_num = +m[2] - 1;
	let here = m[3];
	diagnostics.push({
		severity: DiagnosticSeverity.Error,
		range: {
			start: { line: line_num, character: 0 },
			end: { line: line_num, character: 1000 }
		},
		message: finding,
		source: 'perl6'
	});}

function parse_generics(msg: string, diagnostics: Diagnostic[]) {
	let reea;
	let text = msg.replace(/===SORRY.*\r?\n/, "");
	while( reea = /.*\r?\nat .*?:\d+\r?\n------> .*/.exec(text)) {
		let single = reea[0];
		parse_generic_single(single, diagnostics);
		text = text.slice(single.length);
	}
}

function parseErrorMessage(msg: string, diagnostics: Diagnostic[]) {
	let m = /Could not find (\S+) at line (\d+) in:[\r\n]([\s\S]+)/.exec(msg);
	if (m) {
		parse_missing_libs(m, diagnostics);
		return;
	}

	m = /Undeclared names?:\r?\n([\s\S]+)/.exec(msg);
	if (m) {
		parse_undeclared('name', m[1], diagnostics);
	}
	m = /Undeclared routines?:\r?\n([\s\S]+)/.exec(msg);
	if (m) {
		parse_undeclared('routine', m[1], diagnostics);
		return;
	}

	parse_generics(msg, diagnostics);
}

function validateTextDocument(textDocument: TextDocument): void {
	let diagnostics: Diagnostic[] = [];
	let path = Uri.parse(textDocument.uri).fsPath;
	let myenv = process.env;
	myenv.RAKUDO_ERROR_COLOR = 0;
	var tmpfile = tmp.tmpNameSync({ prefix: 'vscode-perl6-', postfix: '.p6' });
	fs.writeFileSync(tmpfile, textDocument.getText());
	let exec = require('child_process').exec;
	exec('perl6 -c "' + tmpfile + '"', myenv,
		function callback(error, stdout, stderr) {
			fs.unlinkSync(tmpfile);
			if (error && stderr) {
				parseErrorMessage(stderr, diagnostics);
			}
			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		}
	);
}

connection.onDidChangeWatchedFiles((change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	// The pass parameter contains the position of the text document in 
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.
	return [
		{
			label: 'TypeScript',
			kind: CompletionItemKind.Text,
			data: 1
		},
		{
			label: 'JavaScript',
			kind: CompletionItemKind.Text,
			data: 2
		}
	]
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = 'TypeScript details',
			item.documentation = 'TypeScript documentation'
	} else if (item.data === 2) {
		item.detail = 'JavaScript details',
			item.documentation = 'JavaScript documentation'
	}
	return item;
});

let t: Thenable<string>;

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.textDocument.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.textDocument.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});

connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});

connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();