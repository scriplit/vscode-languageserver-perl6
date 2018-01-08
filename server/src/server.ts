/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument, 
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem, 
	CompletionItemKind
} from 'vscode-languageserver';

import Uri from 'vscode-uri';
import tmp = require('tmp');
import fs = require('fs');

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let perl6Path: string;

connection.console.log("Language server started...");

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
	connection.console.log(`[Server(${process.pid}) ${workspaceRoot}] Started and initialize received`);
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
	perl6: Perl6Settings;
}

// These are the settings we defined in the client's package.json
interface Perl6Settings {
 	path: string;
}

// hold the maxNumberOfProblems setting
// let _maxNumberOfProblems: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	let path = settings.perl6.path;
	checkExec(path);
	//_maxNumberOfProblems = settings.languageServerPerl6.maxNumberOfProblems || 100;
	// Revalidate any open text documents
	documents.all().forEach(validateTextDocument);
});

function checkExec(path: string) {
	let exec = require('child_process').exec;
	let myenv = process.env;
	myenv.RAKUDO_ERROR_COLOR = 0;
	if (path) {
		// Take what was configured in settings
		perl6Path = path;
	}
	else {
		// Assume perl6 is in the $PATH
		perl6Path = "perl6";
	}
	exec(perl6Path + ' -v', myenv,
		function callback(error: string, _stdout: string, stderr: string) {
			if (error && stderr) {
				connection.window.showErrorMessage(stderr);
			}
		}
	);	
}

function parseUndeclared(type: string, lines: string, diagnostics: Diagnostic[]) {
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

function parseMissingLibs(m: RegExpExecArray, diagnostics: Diagnostic[]) {
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

function parseGenerics(msg: string, diagnostics: Diagnostic[]) {
	let m;
	let finding;
	let line_num;
	let text = msg.replace(/===SORRY.*\r?\n/, "");
	if( m = /(.*)\r?\nat .*?:(\d+)\r?\n------> .*/.exec(text)) {
		finding = m[1];
		line_num = +m[2] - 1;
	}
	else {
		finding = text;
		line_num = 0;
	}
	diagnostics.push({
		severity: DiagnosticSeverity.Error,
		range: {
			start: { line: line_num, character: 0 },
			end: { line: line_num, character: 1000 }
		},
		message: finding,
		source: 'perl6'
	});
}

function parseErrorMessage(msg: string, diagnostics: Diagnostic[]) {
	let m = /Could not find (\S+) at line (\d+) in:[\r\n]([\s\S]+)/.exec(msg);
	if (m) {
		parseMissingLibs(m, diagnostics);
		return;
	}

	m = /Undeclared names?:\r?\n([\s\S]+)/.exec(msg);
	if (m) {
		parseUndeclared('name', m[1], diagnostics);
	}
	m = /Undeclared routines?:\r?\n([\s\S]+)/.exec(msg);
	if (m) {
		parseUndeclared('routine', m[1], diagnostics);
		return;
	}

	parseGenerics(msg, diagnostics);
}

function validateTextDocument(textDocument: TextDocument): void {
	connection.console.log("\tValidating...");
	let diagnostics: Diagnostic[] = [];
	let path = Uri.parse(textDocument.uri).fsPath;
	connection.console.log("\t\tFile: " + path);
	let myenv = process.env;
	myenv.RAKUDO_ERROR_COLOR = 0;
	var tmpfile = tmp.tmpNameSync({ prefix: 'vscode-perl6-', postfix: '.p6' });
	connection.console.log("\t\tTemp: " + tmpfile);
	fs.writeFileSync(tmpfile, textDocument.getText());
	let exec = require('child_process').exec;
	connection.console.log("\t\tRunning perl6...");
	exec(perl6Path + ' -c "' + tmpfile + '"', myenv,
		function callback(error: string, _stdout: string, stderr: string) {
			fs.unlinkSync(tmpfile);
			if (error && stderr) {
				connection.console.log("\t\tstdErr: " + stderr);
				parseErrorMessage(stderr, diagnostics);
			}
			connection.console.log("Diag: " + JSON.stringify(diagnostics));
			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		}
	);
}

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
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

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();
