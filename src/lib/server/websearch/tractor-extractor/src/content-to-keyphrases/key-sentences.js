import LanguageTokenizer from "compromise";

import { TextRank } from "./graph-centrality-rank.js";
import { addNGrams } from "./ngrams.js";

import nlpWikipedia from "../../node_modules/compromise-wikipedia/builds/compromise-wikipedia.mjs";
LanguageTokenizer.extend(nlpWikipedia);


/**
 * Weights sentences using TextRank noun keyphrase frequency
 * to find which sentences centralize and tie together keyphrase
 * concepts refered to most by other sentences. Based on the
 * TextRank & PageRank algorithms, it randomly surfs links to nodes
 * to find probability of being at that node, thus ranking influence.
 *
 * Kazemi et al (2020). Biased TextRank: Unsupervised Graph-Based
 * Content Extraction. Proceedings of the 28th International
 * Conference on Computational Linguistics.
 * https://aclanthology.org/2020.coling-main.144.pdf
 *
 * Hongyang Zhao and Qiang Xie 2021 J. Phys.: Conf. Ser. 2078 012021
 * "An Improved TextRank Multi-feature Fusion Algorithm For
 * Keyword Extraction of Educational Resources"
 * https://iopscience.iop.org/article/10.1088/1742-6596/2078/1/012021/pdf
 *
 * @param {string} inputString
 * @param {object} options
 * @returns {Array<Object>} [{text, keyphrases, weight}] array of sentences
 */
export function weightKeySentences(inputString, options = {}) {
  var {
    maxWords = 4,
    minWords = 1,
    minWordLength = 3,
    topKeyphrasesPercent = 0.2,
    limitTopSentences = 5,
    limitTopKeyphrases = 5,
    minKeyPhraseLength = 5,
  } = options || {};

  //add space before < to ensure split sentences
  inputString = inputString.replace(/</g, " <").replace(/>/g, "> ");
  var nGrams = {};

  var sentencesPOS = LanguageTokenizer(inputString)
    .normalize({
      possessives: true,
      plurals: true,
    })
    .json() // [...{text: "", terms: [...{tags:[], text, normal, pre, post}] }]
    .map((sentence, sentenceNumber) => {
      // console.log(sentence.text);
      if (sentence.text.includes("<p>")) {
        sentence.startsParagraph = true;
      }
      for (var i = 0; i < sentence.terms.length; i++) {
        for (var nGramSize = minWords; nGramSize <= maxWords; nGramSize++) {
          addNGrams(
            nGramSize,
            sentence.terms,
            i,
            nGrams,
            minWordLength,
            sentenceNumber
          );
        }
      }

      return sentence.text;
      // return {startsPar: sentence.startsParagraph, text: sentence.text, index: sentenceNumber};
    });

  //give keyphrases weight of num_occurences ^ word_count
  var keyphraseGrams = [];
  for (var nGramSize = minWords; nGramSize <= maxWords; nGramSize++)
    keyphraseGrams = keyphraseGrams.concat(
      Object.entries(nGrams[nGramSize]).map(([keyphrase, sentences]) => {
        return {
          keyphrase,
          sentences,
          words: nGramSize,
          weight: sentences.length * nGramSize,
        };
      })
    );
  //sort keyphrases by words
  keyphraseGrams = keyphraseGrams.sort((a, b) => b.words - a.words);

  //fold smaller keyphrases that are subsets of larger ones
  var keyphrasesFolded = [];

  for (var keyphraseGram of keyphraseGrams) {
    var shouldAddCurrent = true;

    for (var i = 0; i < keyphrasesFolded.length; i++) {
      var phrase = keyphraseGram.keyphrase;
      var lastWordIndex = phrase.lastIndexOf(" ");

      //check if larger includes smaller phrase or smaller phrase minus last word
      if (
        keyphrasesFolded[i].keyphrase.indexOf(phrase) > -1 ||
        (lastWordIndex > 5 &&
          keyphrasesFolded[i].keyphrase.includes(
            phrase.substring(0, lastWordIndex)
          ))
      ) {
        //combine weight of smaller keyphrase into larger, divided by word count
        keyphrasesFolded[i].weight +=
          keyphraseGram.weight /
          keyphrasesFolded[i].keyphrase.split(" ").length;
        keyphrasesFolded[i].sentences = keyphrasesFolded[i].sentences.concat(
          keyphraseGram.sentences
        );

        // use whatever version has greater weight as keyphrase text
        if (keyphrasesFolded[i].weight < keyphraseGram.weight)
          keyphrasesFolded[i].keyphrase = keyphraseGram.keyphrase;

        shouldAddCurrent = false;
      }
    }

    if (shouldAddCurrent && keyphraseGram.sentences.length >= 2)
      keyphrasesFolded.push(keyphraseGram);
  }

  keyphraseGrams = keyphrasesFolded.sort((a, b) => b.weight - a.weight);

  //deduplicate and enforce unique values
  var keyphraseGramsUnique = {};
  keyphraseGrams = keyphraseGrams
    .map((keyphrase) => {
      keyphrase.sentences = [...new Set(keyphrase.sentences)];
      if (keyphraseGramsUnique[keyphrase.keyphrase]) return false;
      keyphraseGramsUnique[keyphrase.keyphrase] = 1;

      return keyphrase;
    })
    .filter(Boolean);

  var limitKeyPhrases = Math.floor(
    keyphrasesFolded.length * topKeyphrasesPercent
  );
  if (limitKeyPhrases < limitTopKeyphrases)
    limitKeyPhrases = limitTopKeyphrases;

  //weight wiki entities
  keyphraseGrams = keyphraseGrams
    .map((keyphraseGram) => {
      var phraseTokenized = LanguageTokenizer(keyphraseGram.keyphrase);

      var isEntity = phraseTokenized.topics().out("array").length;
      if (isEntity) {
        keyphraseGram.isEntity = true;
        keyphraseGram.weight = keyphraseGram.weight * 2;
      }

      var wikiEntities = phraseTokenized.wikipedia().json();
      if (wikiEntities.length) {
        keyphraseGram.wikiEntity = wikiEntities[0].text;
        keyphraseGram.weight = keyphraseGram.weight * 2;
        // console.log(keyphraseGram.wikiEntity);
      }

      return keyphraseGram;
    })
    .filter(k => k.keyphrase.length > minKeyPhraseLength)
    .sort((a, b) => b.weight - a.weight)
    //limit to top % of keyphrases to give weights to
    .slice(0, limitKeyPhrases);

  // create sentenceKeysMap  [{text,index,keyphrases:[{text,weight}] }]
  var sentenceKeysMap = [];
  for (var i = 0; i < sentencesPOS.length; i++)
    sentenceKeysMap.push({
      text: sentencesPOS[i],
      index: i,
      keyphrases: [],
    });

  keyphraseGrams.forEach(({ keyphrase, sentences, weight }) => {
    for (var sentenceNumber of sentences)
      sentenceKeysMap[sentenceNumber].keyphrases.push({ keyphrase, weight });
  });

  //run text rank
  var sorted_sentences = TextRank(sentenceKeysMap);

  if (sorted_sentences)
    sorted_sentences = sorted_sentences.sort((a, b) => {
      return b.weight - a.weight;
    });

  //cut off top K limit
  sorted_sentences = sorted_sentences
    ?.slice(0, limitTopSentences)
    .map((s) => ({
      index: s.index,
      keyphrases: s.keyphrases.map((k) => k.keyphrase),
    }));
  keyphraseGrams = keyphraseGrams.slice(0, limitTopKeyphrases);

  return { sorted_sentences, keyphraseGrams, sentences: sentencesPOS };
}

/**
 * Weights sentences using TextRank to find which centralize
 * and tie together keyphrases, boosts weight to keyphrase query
 * to find sentences relevant to user.
 * @param {Array<Object>} sorted_sentences
 * @param {string} query
 * @returns {Array<Object>} [{text, keyphrases, weight}] array of sentences
 */
export function weightKeyphraseQuery(sorted_sentences, query) {
  for (var sentence of sorted_sentences)
    for (var keyphrase of sentence.keyphrases)
      if (keyphrase.keyphrase == query) keyphrase.weight += 5000;

  //run text rank
  var sorted_sentences = TextRank(sorted_sentences).sort((a, b) => {
    return b.weight - a.weight;
  });

  return sorted_sentences;
}
