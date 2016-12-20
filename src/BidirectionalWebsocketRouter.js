const assert = require("assert");

const JSONRPC = {};
JSONRPC.Exception = require("./Exception");
JSONRPC.Server = require("./Server");
JSONRPC.IncomingRequest = require("./IncomingRequest");
JSONRPC.EndpointBase = require("./EndpointBase");

JSONRPC.Plugins = {};
JSONRPC.Plugins.Client = require("./Plugins/Client/index");
JSONRPC.Utils = require("./Utils");


const WebSocket = require("ws");

const EventEmitter = require("events");


/**
 * The "madeReverseCallsClient" event offers automatically instantiated API clients (API clients are instantiated for each connection, lazily).
 */
module.exports =
class BidirectionalWebsocketRouter extends EventEmitter
{
	/**
	 * If both the client and server plugins are specified, bi-directional JSONRPC over the same websocket is enabled.
	 * 
	 * @param {JSONRPC.Server|null} jsonrpcServer
	 */
	constructor(jsonrpcServer)
	{
		super();

		assert(jsonrpcServer === null || jsonrpcServer instanceof JSONRPC.Server);

		this._jsonrpcServer = jsonrpcServer;

		this._nServerWebSocketConnectionIDCounter = 0;
		this._objSessions = {};
	}


	/**
	 * Returns the connection ID.
	 * 
	 * @param {WebSocket} webSocket
	 * 
	 * @returns {number}
	 */
	async addWebSocket(webSocket)
	{
		if(webSocket.readyState !== WebSocket.OPEN)
		{
			console.log("addWebSocket ignoring webSocket which is not in open state.");
			return;
		}

		const nWebSocketConnectionID = ++this._nServerWebSocketConnectionIDCounter;


		const objSession = {
			webSocket: webSocket,
			nWebSocketConnectionID: nWebSocketConnectionID,
			clientReverseCalls: null,
			clientWebSocketTransportPlugin: null
		};

		this._objSessions[nWebSocketConnectionID] = objSession;

		webSocket.on(
			"close",
			(code, message) => {
				delete this._objSessions[nWebSocketConnectionID];
			}
		);

		webSocket.on(
			"error",
			(error) => {
				delete this._objSessions[nWebSocketConnectionID];

				if(webSocket.readyState === WebSocket.OPEN)
				{
					webSocket.close(
						/* CloseEvent.Internal Error */ 1011, 
						error.message
					);
				}
			}
		);

		webSocket.on(
			"message", 
			async (strMessage) => 
			{
				await this._routeMessage(strMessage, objSession);//.then(() => {}).catch(console.error);
			}
		);

		return nWebSocketConnectionID;
	}


	/**
	 * If the client does not exist, it will be generated and saved on the session.
	 * Another client will not be generated automatically, regardless of the accessed endpoint's defined client class for reverse calls.
	 * 
	 * @param {number} nConnectionID
	 * @param {Class} ClientClass
	 * 
	 * @returns {JSONRPC.Client}
	 */
	connectionIDToClient(nConnectionID, ClientClass)
	{
		assert(typeof nConnectionID === "number");
		assert(typeof ClientClass === "function", "Invalid ClientClass value: " + (typeof ClientClass));

		if(!this._objSessions.hasOwnProperty(nConnectionID))
		{
			throw new Error("Connection " + JSON.stringify(nConnectionID) + " not found in BidirectionalWebsocketRouter.");
		}

		if(this._objSessions[nConnectionID].clientReverseCalls === null)
		{
			this._objSessions[nConnectionID].clientReverseCalls = this._makeReverseCallsClient(
				this._objSessions[nConnectionID].webSocket,
				ClientClass,
				this._objSessions[nConnectionID]
			);
		}
		else
		{
			assert(
				this._objSessions[nConnectionID].clientReverseCalls instanceof ClientClass, 
				"clientReverseCalls already initialized with a different JSONRPC.Client subclass."
			);
		}

		return this._objSessions[nConnectionID].clientReverseCalls;
	}


	/**
	 * Overridable to allow configuring the client further.
	 * 
	 * @param {WebSocket} webSocket
	 * @param {Class} ClientClass
	 * @param {Object} objSession
	 * 
	 * @returns {JSONRPC.Client}
	 */
	_makeReverseCallsClient(webSocket, ClientClass, objSession)
	{
		const clientReverseCalls = new ClientClass(webSocket.url ? webSocket.url : webSocket.upgradeReq.url);
		
		objSession.clientWebSocketTransportPlugin = new JSONRPC.Plugins.Client.WebSocketTransport(webSocket, /*bBidirectionalWebSocketMode*/ true);
		clientReverseCalls.addPlugin(objSession.clientWebSocketTransportPlugin);

		this.emit("madeReverseCallsClient", clientReverseCalls);

		return clientReverseCalls;
	}


	/**
	 * Routes websocket messages to either the client or the server websocket plugin.
	 * 
	 * @param {string} strMessage
	 * @param {Object} objSession
	 */
	async _routeMessage(strMessage, objSession)
	{
		const webSocket = objSession.webSocket;
		const nWebSocketConnectionID = objSession.nWebSocketConnectionID;

		if(!strMessage.trim().length)
		{
			console.log("WebSocketBidirectionalRouter: Received empty message. Ignoring.");
			return;
		}

		let objMessage;

		try
		{
			objMessage = JSONRPC.Utils.jsonDecodeSafe(strMessage);
		}
		catch(error)
		{
			console.error(error);
			console.error("Unable to parse JSON. RAW remote message: " + strMessage);

			if(this._jsonrpcServer && this._objSessions[nWebSocketConnectionID].clientWebSocketTransportPlugin === null)
			{
				webSocket.send(JSON.stringify({
					id: null,
					jsonrpc: "2.0",
					error: {
						message: "Invalid JSON: " + JSON.stringify(strMessage) + ".",
						code: JSONRPC.Exception.PARSE_ERROR
					}
				}, undefined, "\t"));
			}

			console.log("Unclean state. Unable to match WebSocket message to an existing Promise or qualify it as a request or response.");
			webSocket.close(
				/* CloseEvent.Internal Error */ 1011, 
				"Unclean state. Unable to match WebSocket message to an existing Promise or qualify it as a request or response."
			);

			return;
		}

		try
		{
			if(objMessage.hasOwnProperty("method"))
			{
				if(!this._jsonrpcServer)
				{
					if(webSocket.readyState === WebSocket.OPEN)
					{
						webSocket.send(JSON.stringify({
							id: null,
							jsonrpc: "2.0",
							error: {
								message: "JSONRPC.Server not initialized on this WebSocket. Raw request: " + strMessage + ".",
								code: JSONRPC.Exception.PARSE_ERROR
							}
						}, undefined, "\t"));
					}

					throw new Error("JSONRPC.Server not initialized on this WebSocket");
				}


				const incomingRequest = new JSONRPC.IncomingRequest();

				incomingRequest.connectionID = nWebSocketConnectionID;
				incomingRequest.bidirectionalWebsocketRouter = this;


				// Move this somewhere in a state tracking class instance of the websocket connection so it is only executed on an incoming connection,
				// for efficiency.
				try
				{
					const strPath = JSONRPC.EndpointBase.normalizePath(webSocket.url ? webSocket.url : webSocket.upgradeReq.url);

					if(!this._jsonrpcServer.endpoints.hasOwnProperty(strPath))
					{
						throw new JSONRPC.Exception("Unknown JSONRPC endpoint " + strPath + ".", JSONRPC.Exception.METHOD_NOT_FOUND);
					}
					incomingRequest.endpoint = this._jsonrpcServer.endpoints[strPath];


					incomingRequest.requestBody = strMessage;
					incomingRequest.requestObject = objMessage;
				}
				catch(error)
				{
					incomingRequest.callResult = error;
				}


				const objResponse = await this._jsonrpcServer.processRequest(incomingRequest);
				webSocket.send(JSON.stringify(objResponse, undefined, "\t"));
			}
			else if(objMessage.hasOwnProperty("result") || objMessage.hasOwnProperty("error"))
			{
				if(this._objSessions[nWebSocketConnectionID].clientWebSocketTransportPlugin === null)
				{
					if(!this._jsonrpcServer)
					{
						if(webSocket.readyState === WebSocket.OPEN)
						{
							webSocket.send(JSON.stringify({
								id: null,
								jsonrpc: "2.0",
								error: {
									message: "JSONRPC.Client not initialized on this WebSocket. Raw message: " + strMessage + ".",
									code: JSONRPC.Exception.PARSE_ERROR
								}
							}, undefined, "\t"));
						}
					}

					if(webSocket.readyState === WebSocket.OPEN)
					{
						webSocket.close(
							/* CloseEvent.Internal Error */ 1011, 
							"How can the client be not initialized, and yet getting responses from phantom requests? Closing websocket."
						);
					}

					throw new Error("How can the client be not initialized, and yet getting responses from phantom requests?");
				}
				await this._objSessions[nWebSocketConnectionID].clientWebSocketTransportPlugin.processResponse(strMessage, objMessage);
			}
			else
			{
				throw new Error("Unable to qualify the message as a JSONRPC request or response.");
			}
		}
		catch(error)
		{
			console.error(error);
			console.error("Uncaught error. RAW remote message: " + strMessage);

			if(this._jsonrpcServer && this._objSessions[nWebSocketConnectionID].clientWebSocketTransportPlugin === null)
			{
				if(webSocket.readyState === WebSocket.OPEN)
				{
					webSocket.send(JSON.stringify({
						id: null,
						jsonrpc: "2.0",
						error: {
							message: "Internal error: " + error.message + ".",
							code: JSONRPC.Exception.INTERNAL_ERROR
						}
					}, undefined, "\t"));
				}
			}

			if(webSocket.readyState === WebSocket.OPEN)
			{
				console.log("Unclean state. Closing websocket.");
				webSocket.close(
					/* CloseEvent.Internal Error */ 1011, 
					"Unclean state. Closing websocket."
				);
			}

			return;
		}
	}
};