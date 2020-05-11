import { config } from '../app';
import * as rp from 'request-promise-native';
import * as _ from 'lodash';

import * as ift_service from './ift-service';

export interface TraceOutput {
  productTraced: ProductInformation;
  inputEpcInfo: ProductInformation[];
}

export interface ProductInformation {
  epcId: string;
  productName: string;
  productGtin: string;
  eventInfo: EventInfo[];
}

export interface EventInfo {
  bizStep: string;
  eventLocation: string; // location where the event occurred (bizLocation)
  sourceLocation: Location[];
  destinationLocation: Location[];
  eventDate: Date;
  transactions: any;
}

export interface Location {
  locationId: string;
  locationName: string;
  locationType: string;
  locationOwner: string;
}

const eventsMap = new Map();
const locationMap = new Map();
let productArray = [];
const transactionsMap = {
  po: new Map(),
  da: new Map(),
  ra: new Map()
};
let productMasterData = [];

/**
 * Scenario 1: Given a product and time range get all the epcs and the related data
 * @param req
 */
export async function getSourceEPCData(req) {
  // 1) get all the epcs by lots_and_serials
  const lotsAndSerials = await ift_service.getProductLotsAndSerials(req);

  // TODO: change the handling to handle a large number of trace calls
  // If the number of lots and serials are greater than 50 (for the moment), ask the user to narrow the
  // search using the date filters
  if (lotsAndSerials.length > 50) {
    return('Dataset returned is too large. Try narrowing your search using the date filters.');
  }

  // 2) trace upstream on all epcs from step 1
  const traceData = await ift_service.runTrace(req, lotsAndSerials, true);

  // 3) Extract all the assestIDs from all the trace results
  const epcTraceMap = new Map();
  let assets = [];
  if (traceData.length > 0) {
    traceData.forEach(setOfEvents => {
      const traceMap = ift_service.getEpcEventsMapFromTrace(setOfEvents);
      epcTraceMap.set(setOfEvents.epc_id, traceMap);
      assets.push(...getAssetList(traceMap));
    });
  }
  assets = [...new Set(assets)]; // unique array of asset ids

  // 4) get all the events for the assetId's from step 3, where event is aggregation/observation &
  // event end date strictly before the end date provided.
  // Not using the start date as a filter here as the start time at a place of origin or commission can be
  // more than a month earlier as compared to the event that occured at the store)
  // - optional limit on biz_step = "shipping/packing" (too limiting - since biz_steps not the same for all orgs)
  const allEventData = await ift_service.getEvents(req, assets);
  // some events falling outside the date range get filtered out here.

  // Once the event data is fetched, loop through it and create maps for events, locations, products & transactions
  processEventData(allEventData);

  // locationArray = [...new Set(locationArray)];
  productArray = [...new Set(productArray)];

  // 5) Get all location ID's and from event data and call locations api for details
  const locationMasterData = await ift_service.getLocationsData(req, Array.from(locationMap.keys()));

  // update the location map
  locationMasterData.forEach((location) => {
    locationMap.set(location.id, location);
  });

  // 6) Get all product ID's and from event data and call product api for details
  productMasterData = await ift_service.getProductsData(req, productArray);

  // TODO: use a product map to store the data
  // productMasterData.forEach((product) => productMap.set(product.id, product));
  // Cant use the product map here as there are multiple products with the same id.
  // Will loop through the master data object for now

  // 7) Get transactions data for each type (PO/DA/RA)
  const poMasterData = await ift_service.getTransactionsData(req, Array.from(transactionsMap.po.keys()), 'PO');
  poMasterData.forEach((po) => transactionsMap.po.set(po.transaction_id, po));

  const daMasterData = await ift_service.getTransactionsData(req, Array.from(transactionsMap.da.keys()), 'DA');
  daMasterData.forEach((da) => transactionsMap.da.set(da.transaction_id, da));

  const raMasterData = await ift_service.getTransactionsData(req, Array.from(transactionsMap.ra.keys()), 'RA');
  raMasterData.forEach((ra) => transactionsMap.ra.set(ra.transaction_id, ra));

  // get formatted output
  const output = formatOutput(epcTraceMap);
  return output;
}

/**
 * Method to return the formatted output
 */
export function formatOutput(epcTraceMap) {
  // form the response array
  const formattedOutputObj = [];
  let productData;
  let inputPData;

  epcTraceMap.forEach(tracedData => {
    const eachTraceOutput: TraceOutput = <TraceOutput>{};
    const prodInfo: ProductInformation = <ProductInformation>{};

    prodInfo.epcId = tracedData.outputs.epc_id;
    const [eventArr, orgId] = getFormattedEventsArray(tracedData.outputs.events);
    // get product Gtin from epc
    const productGtinInfo = getProductFromEpc(tracedData.outputs.epc_id);
    const products = productMasterData.filter((product) => {
      return (product.id === productGtinInfo.gtin);
    });

    if (products) {
      if (products.length > 1) {
        // since its possible to have multiple master records for a particular gtin
        // we use the org it to get the correct master data
        // the assumption is that all the events for a particular epc belong to 1 org
        productData = products.find((product) => {
          return (product.org_id === orgId);
        });
      }
      prodInfo.productGtin = productData && productData.id || products[0].id;
      prodInfo.productName = productData && productData.description || products[0].description;
    }
    prodInfo.eventInfo = eventArr;
    eachTraceOutput.productTraced = prodInfo;

    const inputInfoArray = [];
    // loop through the inputs
    tracedData.inputs.forEach(input => {
      const inputProdInfo: ProductInformation = <ProductInformation>{};
      inputProdInfo.epcId = input.epc_id;
      const [inputEventArr, inputEventOrgId] = getFormattedEventsArray(input.events);
      // get product Gtin from epc
      const inputProductGtinInfo = getProductFromEpc(input.epc_id);

      const inputProducts = productMasterData.filter((product) => {
        return (product.id === inputProductGtinInfo.gtin);
      });

      if (inputProducts) {
        if (inputProducts.length > 1) {
          // since its possible to have multiple master records for a particular gtin
          // we use the org it to get the correct master data
          // the assumption is that all the events for a particular epc belong to 1 org
          inputPData = inputProducts.find((product) => {
            return (product.org_id === inputEventOrgId);
          });
        }
        inputProdInfo.productGtin = inputPData && inputPData.id || inputProducts[0].id;
        inputProdInfo.productName = inputPData && inputPData.description || inputProducts[0].description;
      }

      inputProdInfo.eventInfo = inputEventArr;
      inputInfoArray.push(inputProdInfo);
    });
    eachTraceOutput.inputEpcInfo = inputInfoArray;
    formattedOutputObj.push(eachTraceOutput);
  });
  return formattedOutputObj;
}

/**
 * Method that will loop through the event data and update a list of maps
 * 1) AssetId to event Map
 * 2) Locations map (without the location master data)
 * 3) Product array (Without the product data)
 * 4) Transactions Map
 */
function processEventData(eventData) {
  eventData.forEach((event) => {
    eventsMap.set(event.asset_id, event);
    const locArr = [
      event['biz_location_id'],
      // event['biz_sub_location_id'],
      ...event['source_location_ids'], // these can be an array of locations
      // ...event['source_sub_location_ids'],
      ...event['destination_location_ids'],
      // ...event['destination_sub_location_ids'],
    ];
    locArr.forEach((location) => locationMap.set(location, undefined)); // default to undefined
    // locationArr = [...locationArr, ...locArr];

    // event.epcs_ids.forEach((epc) => {
    //   if (!epc.includes('sscc')) {
    //     productMap.set(epc, undefined); // default to undefined till we populate with master data
    //   }
    // });

    event.epcs_ids.forEach((epc) => {
      const product = getProductFromEpc(epc);
      if (product) {
        productArray.push(product.gtin);
      }
    });
    productArray = [...new Set(productArray)];
    // again default the transaction map data to undefined to be filled later
    event.transaction_ids.forEach((transaction) => {
      if (transaction.type.includes(':po')) {
        transactionsMap.po.set(transaction.id, undefined);
      } else if (transaction.type.includes(':desadv')) {
        transactionsMap.da.set(transaction.id, undefined);
      } else if (transaction.type.includes(':recadv')) {
        transactionsMap.ra.set(transaction.id, undefined);
      }
    });
  });

  // return [locationArr, productArr];
}

/**
 * Method to get all the assetId's from the epcEvents map
 */
function getAssetList(epcEventsMap): string[] {
  const assetIds = [];
  epcEventsMap.outputs.events.forEach(event => {
    assetIds.push(event.asset_id);
  });

  epcEventsMap.inputs.forEach(epcData => {
    epcData.events.forEach(event => {
      assetIds.push(event.asset_id);
    });
  });
  return assetIds;
}

/**
 * Method to get the required location data from the map
 */
function getLocationInfo(locations): Location[] {
  const locArray = [];
  locations.forEach(loc => {
    const locData = locationMap.get(loc);
    if (locData) {
      locArray.push({
        locationId: loc,
        locationName: locData.party_name,
        locationType: locData.party_role_code,
        locationOwner: locData.org_id
      });
    }
  });
  return locArray;
}

/**
 * Method to get the required transaction data from the map
 */
function getTransactionInfo(transactions) {
  const transArray = [];
  transactions.forEach(transaction => {
    if (transaction.type.includes(':po')) {
      transArray.push(transactionsMap.po.get(transaction.id));
    } else if (transaction.type.includes(':desadv')) {
      transArray.push(transactionsMap.da.get(transaction.id));
    } else if (transaction.type.includes(':recadv')) {
      transArray.push(transactionsMap.ra.get(transaction.id));
    }
  });
  return transArray;
}

function getProductFromEpc(epc: string) {
  let product;
  if (epc && ((epc.indexOf(ift_service.constants.URN_GS1_SGTIN) >= 0) ||
    (epc.indexOf(ift_service.constants.URN_IFT_SGTIN) >= 0) ||
    (epc.indexOf(ift_service.constants.URN_PAT_SGTIN) >= 0))) {
    product = ift_service.getSGTIN(epc);
  } else if (epc && ((epc.indexOf(ift_service.constants.URN_GS1_LGTIN) >= 0) ||
    (epc.indexOf(ift_service.constants.URN_IFT_LGTIN) >= 0))) {
    product = ift_service.getLGTIN(epc);
  }
  return product;
}

/**
 * Return a formatted events array
 */
function getFormattedEventsArray(eventList) {
  const eventArr = [];
  let orgId;
  eventList.forEach((event) => {
    const eventInfo = eventsMap.get(event.asset_id);
    if (eventInfo) {
      orgId =  eventInfo.org_id;
      // Get the shipping and transaction info
      eventArr.push({
        bizStep: eventInfo.biz_step,
        eventDate: eventInfo.event_time,
        eventLocation: (locationMap.get(eventInfo.biz_location_id)).party_name,
        sourceLocation: getLocationInfo(eventInfo.source_location_ids),
        destinationLocation: getLocationInfo(eventInfo.destination_location_ids),
        transactions: getTransactionInfo(eventInfo.transaction_ids)
      });
    }
  });
  return [eventArr, orgId];
}
