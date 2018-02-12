import { Component } from 'react';
import { action } from 'mobx';
import { observer } from 'mobx-react';
import PropTypes from 'prop-types';
import web3 from 'web3';

@observer
class AbstractSetting extends Component {

  constructor (props) {
    super(props)
    this.onChange = this.onChange.bind(this);
  }

  validators = {}

  integerValidator (){
    const { _validations } = this.props;
    return{
      validator:(value)=> {
        if(!new RegExp('^\\d+$').test(value))return 1
        if(!Number(value) > 0)return 2
        return 0;
      },
      errors: [
        _validations.Errors.numeric,
        _validations.Errors.minimum_numeric
      ]
    }
  }

  decimalValidator (){
    const { _validations } = this.props;
    return{
      validator:(value)=> {
        if(!new RegExp('^\\d+\\.?\\d*$').test(value))return 1
        if(!Number(value) > 0)return 2
        return 0;
      },
      errors: [
        _validations.Errors.numeric,
        _validations.Errors.minimum_decimal
      ]
    }
  }

  booleanValidator (){
    return{
      validator:(value)=> {
        if(!value && value !== true) return 1;
        return 0;
      },
      errors: [
        'Kindly indicate Value'
      ]
    }
  }

  getValidations() {
    return this._validations
  }

  @action
  validate = (property) => () => {
    const { props: { scheduleStore },_validationsErrors } = this;
    const validations = this.getValidations();
    const { validator,errors } = this.validators[property];
    const value = scheduleStore[property];
    const errorState = validator(value,web3);
    if(errorState == 0){
      validations[property] = true;
      _validationsErrors[property] = '';
    }
    else{
      validations[property] = false;
      _validationsErrors[property] = errors[errorState-1];
    }
    return validations[property];
  }

	onChange = (name) => (event)=> {
		const { target } = event;
		const { scheduleStore } = this.props;
		scheduleStore[name] = target.value;
    this.validate(name)(event);
  }

}

AbstractSetting.propTypes = {
  scheduleStore: PropTypes.any,
  _validations: PropTypes.any,
  _validationsErrors: PropTypes.any
};

export default AbstractSetting;
