import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { inject, observer } from 'mobx-react';
import Cookies from 'js-cookie';

@inject('timeNodeStore')
@observer
class TimeNodeProve extends Component {

  constructor(props) {
    super(props);
    this.verifyDayTokens = this.verifyDayTokens.bind(this);
  }

  verifyDayTokens() {
    const signature = this.signature.value;
    const ethAddress = this.ethAddress.value;
    const timeNodeStore = this.props.timeNodeStore;

    // TEMPORARY
    // Replace this logic with a proper signature check
    if (signature && ethAddress) {
      Cookies.set('hasDayTokens', true);
      timeNodeStore.hasDayTokens = true;
    }
  }

  render() {
    return (
      <div id="timeNodeProve" className="tab-content">
        <div className="tab-pane active show padding-25">
          <h2>Sign to prove DAY ownership</h2>

          <div className="row">
            <div className="col-md-6">
              <p>TimeNode functionality requires a wallet address that holds DAY tokens.</p>
              <p>Please follow these steps to attach it:</p>
              <ol>
                <li>Visit <a href="https://www.myetherwallet.com/signmsg.html" target="_blank" rel="noopener noreferrer">https://www.myetherwallet.com/signmsg.html</a></li>
                <li>TimeNode: <a href="#">0xf9fcacad8c20b15c891a9cbe2dadaf5c4a55eb62</a>&nbsp;<button className="btn btn-white">Copy</button></li>
              </ol>
              <a href="#">Watch Tutorial</a>
            </div>

            <div className="col-md-6">
              <div className="form-group form-group-default">
                <label>Your ETH Address Holding Day</label>
                <input type="text"
                  placeholder="Enter Your ETH Address"
                  className="form-control"
                  ref={(el) => this.ethAddress = el} />
              </div>

              <div className="form-group form-group-default">
                <label>Signature from MyEtherWallet</label>
                <input type="text"
                  placeholder="Enter Your Signature"
                  className="form-control"
                  ref={(el) => this.signature = el} />
              </div>
            </div>

          </div>
        </div>

        <div className="row">
          <div className="col-md-12">
            <button className="btn btn-primary pull-right mr-4 px-5"
              type="button"
              onClick={this.verifyDayTokens}>Verify</button>
          </div>
        </div>

      </div>
    );
  }
}

TimeNodeProve.propTypes = {
  timeNodeStore: PropTypes.any,
  refreshParent: PropTypes.any
};

export default TimeNodeProve;
