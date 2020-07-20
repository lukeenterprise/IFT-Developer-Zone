import { config } from '../app';
import * as rp from 'request-promise-native';
import * as _ from 'lodash';

import * as ift_service from './ift-service';
import * as retailer from './retailer-actions';

/**
 * All available columns/headers for the csv output
 */
const ALL_HEADERS = {
  productEPC:"Finished Product (EPC)",
  productName:"Finished Product Name",
  productGTIN:"Finished Product GTIN",
  finalLocationID:"Final Location (GLN)",
  finalLocationName:"Final Location Name",
  finalLocationType:"Final Location Type",
  arrivalDate:"Arrival Date",
  ingredientEPC:"Ingredient (EPC)",
  ingredientName:"Ingredient Name",
  ingredientGTIN:"Ingredient GTIN",
  sourceLocationID:"Source Location (GLN)",
  sourceLocationName:"Source Location Name",
  sourceLocationType:"Source Location Type",
  creationDate: "Creation Date",
};

/**
 * Reducing the values in here reduces output viewed in csv output
 */
const CSV_HEADERS = [
  ALL_HEADERS.productEPC,
  ALL_HEADERS.productName,
  ALL_HEADERS.productGTIN,
  ALL_HEADERS.finalLocationID,
  ALL_HEADERS.finalLocationName,
  ALL_HEADERS.finalLocationType,
  ALL_HEADERS.arrivalDate,
  ALL_HEADERS.ingredientEPC,
  ALL_HEADERS.ingredientName,
  ALL_HEADERS.ingredientGTIN,
  ALL_HEADERS.sourceLocationID,
  ALL_HEADERS.sourceLocationName,
  ALL_HEADERS.sourceLocationType,
  ALL_HEADERS.creationDate,
];

// will try to get productGTIN and productName whenever possible

/**
 * CSVRow object to standardize order of output as well as easily
 * 
 */
class CSVRow extends Map<string, string | Date> {
  constructor() {
    super();
    CSV_HEADERS.forEach((col) => this.set(col, null));
    return this;
  }

  /**
   * shallow copy
   */
  copy() {
    const copy = new CSVRow();
    for (let [key, value] of this) {
      copy.set(key, value);
    }
    return copy;
  }
   
  /**
   * produces a valid row as csv string
   * 
   * @returns: row as csv string
   */
  toString(): string {
    const values = CSV_HEADERS.map((col) => this.get(col));
    return JSON.stringify(Array.from(values).map((el) => !!el ? el: "")).slice(1, -1);
  }
};

/**
 * very similar to getSourceEPCData
 * small tweaks in function calls, treatment of transactions
 * get all lots and serials associated with product id
 * 
 * @param req trace requirements
 */
export async function getIngredientSources(req) {
  const lotsAndSerials = await ift_service.getProductLotsAndSerials(req);
  console.log(lotsAndSerials);
  if (lotsAndSerials && lotsAndSerials.length > 50) {
      return [
        [],
        [['Dataset returned is too large. Try narrowing your search using the date filters.']]
      ];
  } else if (!lotsAndSerials || lotsAndSerials.length == 0) return [CSV_HEADERS, []];;

  let traceData = await ift_service.runTrace(req, lotsAndSerials, {upstream: true, downstream: false});
  console.log(JSON.stringify(traceData, null, 2));
  
  // process event assets and parent assets
  let assets = [];
  const parentAssetMap = {};

  if (traceData && traceData.length > 0) {
    traceData.forEach(productTrace => {
      assets.push(...getAssetIDs(productTrace));
    });

    // process parent assets
    traceData.forEach(productTrace => {
      assets.push(...processParentAssets(productTrace, parentAssetMap));
    });
  } else { return [CSV_HEADERS, []]; }

  assets = _.uniq(assets);

  // get all related event, location, and product information
  const allEventData: any[] = await ift_service.getEvents(req, assets, []);

  const [assetEventMap, locationMap, productArr]: [Map<any,any>, Map<any,any>, any[]] = processEventInfo(allEventData);

  const locationMasterData = await ift_service.getLocationsData(req, Array.from(locationMap.keys()));
  const productMasterData = await ift_service.getProductsData(req, productArr);
  
  locationMasterData.forEach((location) => {
    locationMap.set(location.id, location);
  }); // populate locationMap with information
  
  // important data used in generating CSVs
  const masterData = {
    events: assetEventMap,
    locations: locationMap,
    products: productMasterData,
    parents: parentAssetMap
  };

  const csv_rows: CSVRow[] = [];

  csv_rows.push(...generateProductCSVRows(traceData, masterData));

  return [
      CSV_HEADERS,
      csv_rows
  ];

}

/**
 * processes the parent EPCs since if a parent EPC shows up twice,
 * it only shows the information once in the product trace, we will
 * create a map to hold the information
 * 
 * @param productTrace trace result of the product
 * @param parentAssetMap map keeping track of parent.epc_id --> associated asset ids/events
 */
function processParentAssets(productTrace, parentAssetMap): string[] {
  let assetIDs:string[] = [];
  if (!!productTrace.parent_epcs && productTrace.parent_epcs.length > 0) {
    productTrace.parent_epcs.forEach(parent => {
      let assets = parentAssetMap[parent.epc_id];
      if (!assets) assets = []; // if not kept track yet, initialize empty assets array
      assets.push(...parent.events.map((event) => event.asset_id ).filter((el) => !!el));

      parentAssetMap[parent.epc_id] = _.uniq(assets);
      assetIDs.push(...assets);
    });
  }

  if (!!productTrace.input_epcs && productTrace.input_epcs.length > 0) {
    productTrace.input_epcs.forEach(input_product => {
      assetIDs.push(...processParentAssets(input_product, parentAssetMap));
    })
  }

  return assetIDs;
}

/**
 * Similar to getAssetIds from retailer-actions
 * difference in that this captures intermediate EPCs as well
 * 
 * @param productTrace trace result of the product
 */
function getAssetIDs(productTrace) {
  let assetIDs = [];

  if (!!productTrace.events && productTrace.events.length > 0) {
    assetIDs = productTrace.events.map((event) => event.asset_id).filter((el) => !!el);
  }

  if (!!productTrace.input_epcs && productTrace.input_epcs.length > 0) {
    productTrace.input_epcs.forEach(input_product => {
      assetIDs.push(...getAssetIDs(input_product));
    })
  }

  return assetIDs;
}

/**
 * source: retailer.processEventData
 * difference: ignoring transactions and not utilizing globals
 * 
 * @param allEventData object keeping track of all events
 */
function processEventInfo(allEventData): [Map<any,any>, Map<any,any>, any[]] {
  const assetEventMap = new Map();
  const locationMap = new Map();
  let productArr = [];
  allEventData.forEach((event) => {
    assetEventMap.set(event.asset_id, event);
    const locArr = [
      event['biz_location_id'],
      ...event['source_location_ids'], // these can be an array of locations
      ...event['destination_location_ids'],
    ];
    locArr.forEach((location) => locationMap.set(location, undefined)); // default to undefined
    
    event.epcs_ids.forEach((epc) => {
      const product = retailer.getProductFromEpc(epc);
      if (product) {
        productArr.push(product.gtin);
      }
    });
    productArr = _.uniq(productArr);
  })

  return [assetEventMap, locationMap, productArr];
}


/**
 * Populates CSVRow objects based on product information, then sends it
 * to generateIngredientCSVRows to be populated by the respective
 * ingredient information
 * 
 * @param productTrace trace of the product
 * @param data masterdata object
 */
function generateProductCSVRows(productTrace, data): CSVRow[] {
  const rows: CSVRow[] = [];
  productTrace.forEach(trace => {
    const productRow:CSVRow = new CSVRow();

    productRow.set(ALL_HEADERS.productEPC, trace.epc_id);

    // get event information associated with epc, meanwhile also establish orgId
    let orgId, productData;

    let events = trace.events.map((event) => {
      const eventInfo = data.events.get(event.asset_id);
      if (!!eventInfo) {
        if (!orgId) orgId = eventInfo.org_id;
        return eventInfo;
      } else {
        return undefined;
      }
    }).filter((el) => !!el);

    // push potential parent epc event data
    trace.parent_epcs.forEach((parent) => {
      events.push(...data.parents[parent.epc_id].map((asset_id) => {
        const eventInfo = data.events.get(asset_id);
        if (!!eventInfo) {
          if (!orgId) orgId = eventInfo.org_id;
          return eventInfo;
        } else {
          return undefined;
        }
      }).filter((el) => !!el));
    });

    // collect gtin and name information
    const productGtinInfo = retailer.getProductFromEpc(trace.epc_id);
    const products = data.products.filter((product) => {
      return (product.id === productGtinInfo.gtin);
    });

    if (products) {
      if (products.length > 1) {
        productData = products.find((product) => {
          return (product.org_id === orgId);
        });
      }
      productRow.set(ALL_HEADERS.productGTIN, (productData && productData.id) || (products[0] && products[0].id));
      productRow.set(ALL_HEADERS.productName, (productData && productData.description) || (products[0] && products[0].description));
    }

    // find latest event, populate row with event data
    const {arrivalDate, locationId, locationName, locationType} = findFinalLocation(events, data.locations);
    productRow.set(ALL_HEADERS.arrivalDate, arrivalDate);
    productRow.set(ALL_HEADERS.finalLocationID, locationId);
    productRow.set(ALL_HEADERS.finalLocationName, locationName);
    productRow.set(ALL_HEADERS.finalLocationType, locationType);
    
    // for each input, create a new CSV row
    const inputRows = [];
    inputRows.push(...generateIngredientCSVRows(productRow, trace.input_epcs, data));
    
    if (inputRows.length == 0) {
      // if there are no inputs, try to find the most upstream location of product
      const {creationDate, locationId, locationName, locationType} = findSourceLocation(events, data.locations);
      productRow.set(ALL_HEADERS.creationDate, creationDate);
      productRow.set(ALL_HEADERS.sourceLocationID, locationId);
      productRow.set(ALL_HEADERS.sourceLocationName, locationName);
      productRow.set(ALL_HEADERS.sourceLocationType, locationType);
      rows.push(productRow);
    } else {
      rows.push(...inputRows);
    }
  });
    
  return rows;
}

/**
 * Takes the productRow as a template, then populates it with ingredient specific informaiton
 * 
 * @param productRow base row with populated information of the product
 * @param productTrace trace of the product
 * @param data masterdata object
 */
function generateIngredientCSVRows(productRow:CSVRow, productTrace, data): CSVRow[] {
  const rows: CSVRow[] = [];
  productTrace.forEach(trace => {
    const ingredientRow:CSVRow = productRow.copy();

    ingredientRow.set(ALL_HEADERS.ingredientEPC, trace.epc_id);

    // get event information associated with epc, meanwhile also establish orgId
    let orgId, productData;

    let events = trace.events.map((event) => {
      const eventInfo = data.events.get(event.asset_id);
      if (!!eventInfo) {
        if (!orgId) orgId = eventInfo.org_id;
        return eventInfo;
      } else {
        return undefined;
      }
    }).filter((el) => !!el);

    // push potential parent epc event data
    trace.parent_epcs.forEach((parent) => {
      events.push(...data.parents[parent.epc_id].map((asset_id) => {
        const eventInfo = data.events.get(asset_id);
        if (!!eventInfo) {
          if (!orgId) orgId = eventInfo.org_id;
          return eventInfo;
        } else {
          return undefined;
        }
      }).filter((el) => !!el));
    });

    // collect gtin and name information
    const productGtinInfo = retailer.getProductFromEpc(trace.epc_id);
    const products = data.products.filter((product) => {
      return (product.id === productGtinInfo.gtin);
    });

    if (products) {
      if (products.length > 1) {
        productData = products.find((product) => {
          return (product.org_id === orgId);
        });
      }
      ingredientRow.set(ALL_HEADERS.ingredientGTIN, (productData && productData.id) || (products[0] && products[0].id));
      ingredientRow.set(ALL_HEADERS.ingredientName, (productData && productData.description) || (products[0] && products[0].description));
    }

    // find latest event
    const {creationDate, locationId, locationName, locationType} = findSourceLocation(events, data.locations);
    ingredientRow.set(ALL_HEADERS.creationDate, creationDate);
    ingredientRow.set(ALL_HEADERS.sourceLocationID, locationId);
    ingredientRow.set(ALL_HEADERS.sourceLocationName, locationName);
    ingredientRow.set(ALL_HEADERS.sourceLocationType, locationType);
    
    rows.push(ingredientRow);

    // recurse up tree
    rows.push(...generateIngredientCSVRows(productRow, trace.input_epcs, data));
  });
    
  return rows;
}


/**
 * Selects a final location for an EPC based on its events and the event type
 * based on: retailer.getLocationInfo
 * 
 * @param events list of events
 * @param locationMap master location data mapping location id to location data
 */
function findFinalLocation(events, locationMap): {arrivalDate, locationId, locationName, locationType} {
  if (!events || events.length == 0) return {
    arrivalDate:null,
    locationId:null,
    locationName:null,
    locationType:null
  };
  // const locations: Object[] = [];
  const tieBreaker = ["STORE", "DISTRIBUTION_CENTER", "SUPPLIER", "FARM"]; // NOTE: Any other location types to worry about? party_role_code
  // determine last event;
  const finalEvent = events.reduce((event1, event2) => (event1.event_time > event2.event_time) ? event1 : event2 );

  const finalLocation = [finalEvent.biz_location_id,
  ...finalEvent.destination_location_ids].map((location) => { // map location ids to location information
    const locData = locationMap.get(location);
    return {
      arrivalDate: finalEvent.event_time,
      locationId: location,
      locationName: locData.party_name,
      locationType: locData.party_role_code
    };
  }).reduce((loc1, loc2) => { // reduce to a single location
    const ind1 = (tieBreaker.indexOf(loc1.locationType) === -1) ? tieBreaker.length: tieBreaker.indexOf(loc1.locationType);
    const ind2 = (tieBreaker.indexOf(loc2.locationType) === -1) ? tieBreaker.length: tieBreaker.indexOf(loc2.locationType);
    return (ind1 < ind2) ? loc1: loc2 ;
  })

  return finalLocation;
}

/**
 * Selects a source location for an EPC based on its events and the event type
 * based on: retailer.getLocationInfo
 * 
 * @param events list of events
 * @param locationMap master location data mapping location id to location data
 */
function findSourceLocation(events, locationMap) {
  if (!events || events.length == 0) return {
    creationDate:null,
    locationId:null,
    locationName:null,
    locationType:null
  };

  const locTieBreaker = ["FARM", "SUPPLIER", "DISTRIBUTION_CENTER", "STORE"]; // NOTE: Any other location types to worry about? party_role_code
  const eventTieBreaker = ["aggregation", "observation", "commission"];
  // determine last event;
  const firstEvent = events.reduce((event1, event2) => {
    if (event1.event_time < event2.event_time) {
      return event1;
    } else if (event1.event_time > event2.event_time) {
      return event2;
    } else {
      // evaluate on an index using event tiebreaker values.
      const ind1 = (eventTieBreaker.indexOf(event1.locationType) === -1) ? eventTieBreaker.length: eventTieBreaker.indexOf(event1.event_type);
      const ind2 = (eventTieBreaker.indexOf(event2.locationType) === -1) ? eventTieBreaker.length: eventTieBreaker.indexOf(event2.event_type);
      return (ind1 < ind2) ? event1: event2;
    }
  });

  const sourceLocation = [firstEvent.biz_location_id,
  ...firstEvent.source_location_ids].map((location) => { // map location ids to location information
    const locData = locationMap.get(location);
    return {
      creationDate: firstEvent.event_time,
      locationId: location,
      locationName: locData.party_name,
      locationType: locData.party_role_code
    };
  }).reduce((loc1, loc2) => { // reduce to a single location
    // evaluate on an index using location tiebreaker values.
    const ind1 = (locTieBreaker.indexOf(loc1.locationType) === -1) ? locTieBreaker.length: locTieBreaker.indexOf(loc1.locationType);
    const ind2 = (locTieBreaker.indexOf(loc2.locationType) === -1) ? locTieBreaker.length: locTieBreaker.indexOf(loc2.locationType);
    return (ind1 < ind2) ? loc1: loc2;
  })

  return sourceLocation;
}